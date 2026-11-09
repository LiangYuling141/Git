import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma';
import { contractEngine, contractRegistry, redactArgs, riskToDb } from '@lymtrix/tef-core';
import { EffectExecutionError, EffectsExecutionUnknownError } from '@lymtrix/tef-core';
import { TefError, isTefError } from '@lymtrix/tef-core';
import type {
  ActorType,
  AuditResultType,
  BusinessGateway,
  Contract,
  EffectsExecuteResult,
  EffectsExecutor,
  EntityAdapters,
  Envelope,
  RevalidateOutcome,
} from '@lymtrix/tef-core';
import { auditChain, type AuditEventInput } from '../audit-chain';
import { previewStore, type StoredPreview } from '../preview-store';
import { tokenStore, type TokenClaims } from '../token';
import { withTenantScope } from '../tenant-scope';
import type { PrismaTx } from '../prisma';
import { conflict, errorToEnvelope, fail, needsConfirmation, ok } from '../envelope';
import { buildExecContext, type Principal } from '../principal';

/**
 * 通用契约工具运行时。
 *
 * `order.preview_create` / `order.execute_create` 与补偿工具共用这一套逻辑：
 * - 预览：归一化 → 证据 → Check → 风险 → 快照 → 令牌 → 审计；
 * - 执行：两阶段状态机——本地事务（幂等/令牌/快照/重校验/预审计）→
 *   外部副作用（按幂等键执行）→ 结算事务（结果审计 + 幂等响应）。
 *
 * 垂直差异通过参数注入：contract operation、MCP 工具名、实体适配器工厂。
 * 框架核心不知道 order / product 这些实体，也不依赖任何垂直执行器实现。
 */

export interface ContractWriteOptions {
  traceId: string;
  secret: string;
  now?: Date;
  /** 在租户事务内构造业务数据端口；契约通过 ctx.gateway 读取业务事实。 */
  gatewayFactory?: (tx: PrismaTx, tenantId: string) => BusinessGateway;
  /**
   * 副作用执行器（必填）。由垂直包在进入状态机前注入，kit 不依赖任何垂直实现。
   * 执行器必须按 idempotencyKey 幂等收敛重复调用。
   */
  effectsExecutor: EffectsExecutor;
}

/**
 * 状态机之外的治理操作（预览、确认）所需选项：这些路径不执行副作用，
 * 因此不需要执行器。
 */
export type ContractWriteBaseOptions = Omit<ContractWriteOptions, 'effectsExecutor'>;

/**
 * 垂直工具面向调用方的写选项：执行器可省略，垂直在调用状态机前补齐默认实现；
 * 显式传入时保留调用方覆盖（例如跨服务 HTTP 执行器）。
 */
export type ContractToolOptions = ContractWriteBaseOptions & {
  effectsExecutor?: EffectsExecutor;
};

/**
 * 派生传给 effects 执行器的幂等键。
 *
 * TEF 的幂等域是 `(tenantId, toolName, idempotencyKey)`，而执行器的幂等域是
 * `(tenantId, 'internal.effects.execute', idempotencyKey)`。同一个业务 key 可以
 * 被不同工具复用（例如创建与补偿），如果原样透传，执行器会把另一个操作的结果
 * 当成本次执行的重放，从而跳过真正的副作用。
 *
 * Task 4 的对账必须使用本函数，从 `attempt.toolName` + `attempt.idempotencyKey`
 * 派生出与前台执行完全相同的键。
 */
export function scopedExecutorIdempotencyKey(toolName: string, idempotencyKey: string): string {
  return `${toolName}:${idempotencyKey}`;
}

export type AdapterFactory = (
  tx: PrismaTx,
  tenantId: string,
  meta: { previewId?: string | null; traceId?: string | null },
) => EntityAdapters;

export async function previewContract(
  principal: Principal,
  operation: string,
  args: Record<string, unknown>,
  options: ContractWriteBaseOptions,
  toolName: string,
): Promise<Envelope> {
  const now = options.now ?? new Date();

  try {
    return await withTenantScope(principal.tenantId, async (tx) => {
      const ctx = await buildExecContext(principal, tx, {
        traceId: options.traceId,
        now,
        gateway: options.gatewayFactory?.(tx, principal.tenantId),
      });

      const contract = contractRegistry.get(operation);
      if (!contract) {
        throw new TefError('INTERNAL', `contract ${operation} is not registered`);
      }

      const outcome = await contractEngine.preview(contract, args, ctx);

      if (outcome.blocked) {
        const appended = await auditChain.append(
          {
            traceId: options.traceId,
            tenantId: principal.tenantId,
            actorId: principal.userId,
            actorType: 'agent',
            tool: toolName,
            contract: contract.operation,
            contractVersion: contract.version,
            intentHash: outcome.intentHash,
            argsRedacted: redactArgs(outcome.params as Record<string, unknown>),
            evidenceDigest: outcome.evidenceDigest,
            risk: 'Block',
            reasons: outcome.reasons,
            decision: 'block',
            result: 'failure',
            subjectRef: outcome.audit.subjectRef ?? null,
          },
          tx,
          now,
        );

        return {
          status: 'blocked' as const,
          risk: 'Block' as const,
          reasons: outcome.reasons,
          diff: outcome.diff,
          evidence: outcome.evidence as Record<string, unknown>,
          auditId: appended.eventId,
          traceId: options.traceId,
          error: {
            code: 'VALIDATION_ERROR' as const,
            message: outcome.reasons.join('; '),
            checks: outcome.failedChecks,
          },
        };
      }

      const snapshot = await previewStore.save(
        {
          tenantId: principal.tenantId,
          userId: principal.userId,
          sessionId: principal.sessionId,
          traceId: options.traceId,
          contract: contract.operation,
          contractVersion: contract.version,
          normalizedArgs: outcome.params as Record<string, unknown>,
          intentHash: outcome.intentHash,
          evidenceDigest: outcome.evidenceDigest,
          evidence: outcome.evidence as Record<string, unknown>,
          diff: outcome.diff,
          risk: outcome.risk,
          reasons: outcome.reasons,
          failedChecks: outcome.failedChecks,
        },
        tx,
        now,
      );

      const issued = await tokenStore.issue(
        {
          tenantId: principal.tenantId,
          userId: principal.userId,
          sessionId: principal.sessionId,
          previewId: snapshot.previewId,
          intentHash: snapshot.intentHash,
          contract: contract.operation,
          contractVersion: contract.version,
          risk: outcome.risk,
          traceId: options.traceId,
        },
        tx,
        options.secret,
        now,
      );

      const appended = await auditChain.append(
        {
          traceId: options.traceId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          actorType: 'agent',
          tool: toolName,
          contract: contract.operation,
          contractVersion: contract.version,
          intentHash: snapshot.intentHash,
          argsRedacted: redactArgs(outcome.params as Record<string, unknown>),
          evidenceDigest: snapshot.evidenceDigest,
          risk: outcome.risk,
          reasons: outcome.reasons,
          decision: outcome.risk === 'L2' ? 'confirm' : 'allow',
          result: 'success',
          subjectRef: outcome.audit.subjectRef ?? null,
        },
        tx,
        now,
      );

      const body = {
        risk: outcome.risk,
        reasons: outcome.reasons,
        diff: outcome.diff,
        evidence: outcome.evidence as Record<string, unknown>,
        previewId: snapshot.previewId,
        confirmationToken: issued.token,
        expiresAt: issued.stored.expiresAt.toISOString(),
        auditId: appended.eventId,
        traceId: options.traceId,
      };

      // L2 必须人工 approve；L1 令牌签发即生效（§4.3，公理 I4）
      return outcome.risk === 'L2'
        ? needsConfirmation({ ...body, data: { requiresApproval: true, status: 'awaiting_confirmation' } })
        : ok({ requiresApproval: false, previewId: snapshot.previewId }, body);
    });
  } catch (error) {
    await auditFailureOutOfTransaction(principal, options, now, toolName, operation, error, 'failure');
    return errorToEnvelope(error);
  }
}

/** Phase 1 提交后交给 Phase 2/3 的不可变上下文。 */
export interface ExecutingAttempt {
  attemptId: string;
  contract: Contract<unknown, unknown, unknown>;
  snapshot: StoredPreview;
  claims: TokenClaims;
  revalidated: Extract<RevalidateOutcome, { ok: true }>;
}

/**
 * 结算事务的操作者与时间基准。
 *
 * 前台执行以发起请求的用户身份结算；对账（Task 4）用系统身份补齐结果，
 * 两者共用同一套条件结算与结果审计逻辑，避免对账路径另写一份状态迁移。
 */
export interface SettlementActor {
  tenantId: string;
  actorId: string;
  actorType: ActorType;
  traceId: string;
  /** 结算时间基准；缺省为当前时间。 */
  now?: Date;
}

type Phase1Result =
  | { kind: 'envelope'; envelope: Envelope }
  | ({ kind: 'execute' } & ExecutingAttempt);

/** `execution_attempts` 行的最小结构，避免把 Prisma 类型泄漏到状态机逻辑。 */
interface ExistingAttempt {
  attemptId: string;
  traceId: string;
  status: string;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/**
 * 与旧实现一致：成功响应重放时显式标记 replayed。
 * 失败/冲突信封按原样返回，不额外塞入 data 字段。
 */
function replayIdempotent(response: unknown): Envelope {
  const replayed = response as Envelope;
  if (replayed.status !== 'ok') return replayed;
  return { ...replayed, data: { ...(replayed.data ?? {}), replayed: true } } as Envelope;
}

/** 把数据库里的 Json 结果还原成信封；不是信封形状时返回 null。 */
function storedEnvelope(value: unknown): Envelope | null {
  if (value && typeof value === 'object' && 'status' in value) {
    return value as Envelope;
  }
  return null;
}

/**
 * 已结算失败尝试的响应：优先返回 Phase 3 存储的原始信封。
 *
 * 没有存储信封时（历史数据）仍要携带 `attemptStatus: 'failed'`：这是路由
 * 区分“确定失败、可安全清 marker”与“结果未知、必须保留 marker”的机读信号。
 */
function storedFailureEnvelope(attempt: ExistingAttempt): Envelope {
  const stored = storedEnvelope(attempt.result);
  if (stored) return stored;
  const data = { attemptId: attempt.attemptId, attemptStatus: 'failed' };
  if (attempt.errorCode === 'CONFLICT') {
    return conflict(attempt.errorMessage ?? 'execution failed', { traceId: attempt.traceId, data });
  }
  return fail('INTERNAL', attempt.errorMessage ?? 'execution failed', [], { data });
}

/**
 * 已有执行尝试时的状态映射。
 *
 * - succeeded 但查不到幂等记录：说明治理状态不一致，交给人工对账，不能假装重放；
 * - executing：副作用正在执行，重复请求必须用同一幂等键等待，不能重新预览；
 * - unknown：副作用可能已经发生，用同一幂等键等待对账收敛；
 * - failed：返回首次失败响应，保持确定性（不盲目重试）。
 *
 * executing / unknown 必须返回机器可识别的错误码和 attemptId：Runtime 与确认
 * 路由据此保留 pending 状态与幂等键。返回泛化的 INTERNAL/CONFLICT 会让调用方
 * 误以为操作可以重新开始，从而用新幂等键制造第二次副作用。
 */
function existingAttemptEnvelope(attempt: ExistingAttempt): Envelope {
  if (attempt.status === 'succeeded') {
    return conflict(
      'execution already succeeded but its idempotency record is missing; reconciliation required',
      { traceId: attempt.traceId },
    );
  }
  if (attempt.status === 'executing') {
    return fail(
      'EXECUTION_IN_PROGRESS',
      'execution is already in progress; retry with the same idempotency key instead of creating a new preview',
      [],
      { data: { attemptId: attempt.attemptId, retryWithSameKey: true }, traceId: attempt.traceId },
    );
  }
  if (attempt.status === 'unknown') {
    return fail(
      'EXECUTION_UNKNOWN',
      'execution outcome is unknown; reconciliation is required before retrying with the same idempotency key',
      [],
      { data: { attemptId: attempt.attemptId, retryWithSameKey: true }, traceId: attempt.traceId },
    );
  }
  return storedFailureEnvelope(attempt);
}

/**
 * 尝试状态 → 响应信封。
 *
 * `succeeded` 的重放依赖幂等记录，而 Phase 1 的第一次记录查询发生在 attempt
 * 查询之前：在 READ COMMITTED 下两条语句看到不同快照时，可能出现“attempt
 * 已可见、记录尚未可见”的假缺失。这里在已经读到 succeeded 后于同一事务内
 * 重读记录，消除该时序窗口；仍然缺失才按治理状态不一致交给人工对账。
 */
async function attemptEnvelope(
  tx: PrismaTx,
  tenantId: string,
  toolName: string,
  idempotencyKey: string,
  attempt: ExistingAttempt,
): Promise<Envelope> {
  if (attempt.status === 'succeeded') {
    const record = await tx.idempotencyRecord.findFirst({
      where: { tenantId, toolName, idempotencyKey },
    });
    if (record) return replayIdempotent(record.response);
  }
  return existingAttemptEnvelope(attempt);
}

/**
 * Phase 1：本地事务。
 *
 * 幂等记录与执行尝试的检查必须先于令牌消费：重复请求和并发请求
 * 都不能再消耗一枚一次性令牌。只有走到创建尝试这一步才会提交预审计。
 */
async function runPhase1(
  principal: Principal,
  token: string,
  idempotencyKey: string,
  options: ContractWriteOptions,
  toolName: string,
  failureResult: AuditResultType,
  now: Date,
): Promise<Phase1Result> {
  return withTenantScope(principal.tenantId, async (tx): Promise<Phase1Result> => {
    // 幂等优先于一切：重复请求返回第一次的结果，不重复执行（§4.4）。
    const existing = await tx.idempotencyRecord.findFirst({
      where: { tenantId: principal.tenantId, toolName, idempotencyKey },
    });
    if (existing) {
      return { kind: 'envelope', envelope: replayIdempotent(existing.response) };
    }

    // executing / unknown 表示副作用可能已经发生：不消费令牌，不创建新尝试。
    const attempt = await tx.executionAttempt.findUnique({
      where: {
        tenantId_toolName_idempotencyKey: {
          tenantId: principal.tenantId,
          toolName,
          idempotencyKey,
        },
      },
    });
    if (attempt) {
      return {
        kind: 'envelope',
        envelope: await attemptEnvelope(tx, principal.tenantId, toolName, idempotencyKey, attempt),
      };
    }

    const ctx = await buildExecContext(principal, tx, {
      traceId: options.traceId,
      now,
      gateway: options.gatewayFactory?.(tx, principal.tenantId),
    });

    // 1. 验签 + 验绑定 + 原子消费。重放、跨租户、未批准都在这里被挡下。
    const consumedToken = await tokenStore.consume(
      token,
      { tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId },
      tx,
      options.secret,
      now,
    );
    const claims = consumedToken.claims;

    // 2. 业务参数的唯一来源：预览快照。模型传什么参数都不影响这里。
    const snapshot = await previewStore.consume(principal.tenantId, claims.previewId, tx, now);

    // 3. 令牌与快照必须指向同一份被批准的内容（纵深防御）
    if (snapshot.intentHash !== claims.intentHash) {
      throw new TefError('CONFLICT', 'preview snapshot does not match the approved intentHash');
    }
    if (snapshot.contract !== claims.contract || snapshot.contractVersion !== claims.contractVersion) {
      throw new TefError('CONFLICT', 'preview snapshot was produced by a different contract version');
    }

    // 4. 令牌绑定契约版本：旧版本令牌不能用于新契约（§5.2 约束 5）
    const contract = contractRegistry.get(snapshot.contract, snapshot.contractVersion);
    if (!contract) {
      throw new TefError(
        'CONFLICT',
        `contract ${snapshot.contract}@${snapshot.contractVersion} is no longer registered; re-preview required`,
      );
    }

    // 5. 事务内重校验前置条件。并发变动 → CONFLICT，要求重新预览（§12.2）
    const revalidated = await contractEngine.revalidate(
      contract,
      snapshot.normalizedArgs as never,
      ctx,
      claims.risk,
    );

    if (revalidated.ok === false) {
      // 作废旧令牌：冲突恢复必须重新预览，不能复用（§12.2）
      await tokenStore.revokeByPreview(principal.tenantId, claims.previewId, tx);
      const appended = await auditChain.append(
        {
          traceId: options.traceId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          actorType: 'agent',
          tool: toolName,
          contract: contract.operation,
          contractVersion: contract.version,
          intentHash: claims.intentHash,
          argsRedacted: redactArgs(snapshot.normalizedArgs),
          evidenceDigest: snapshot.evidenceDigest,
          risk: claims.risk,
          reasons: revalidated.reasons,
          decision: 'block',
          result: failureResult,
          subjectRef: null,
        },
        tx,
        now,
      );
      return {
        kind: 'envelope',
        envelope: conflict(revalidated.reasons.join('; '), {
          risk: claims.risk,
          reasons: revalidated.reasons,
          auditId: appended.eventId,
          traceId: options.traceId,
          error: {
            code: 'CONFLICT',
            message: `revalidation failed (${revalidated.cause}); the token was revoked, re-preview to continue`,
            checks: revalidated.failedChecks,
          },
        }),
      };
    }

    // 6. 先提交执行意图（attempt + 预审计），副作用只能发生在它之后。
    const attemptId = `att_${randomUUID()}`;
    const preAuditSpec = contract.audit(snapshot.normalizedArgs as never, revalidated.evidence, null);

    await tx.executionAttempt.create({
      data: {
        attemptId,
        tenantId: principal.tenantId,
        traceId: options.traceId,
        previewId: snapshot.previewId,
        contract: contract.operation,
        contractVersion: contract.version,
        intentHash: claims.intentHash,
        toolName,
        idempotencyKey,
        status: 'executing',
        risk: riskToDb(claims.risk),
        effects: revalidated.effects as unknown as Prisma.InputJsonValue,
        // expectedEvidenceVersion 当前取预览快照的 evidenceDigest，仅作为证据版本
        // 标识透传给执行器。进程内执行器尚未比较该值；版本冲突 → CONFLICT 的
        // 语义（以及冲突后的重新预览）待具备第二证据版本来源后实现（B3/跨服务）。
        expectedEvidenceVersion: snapshot.evidenceDigest,
      },
    });

    const preAppended = await auditChain.append(
      {
        eventId: `${attemptId}:pre`,
        traceId: options.traceId,
        tenantId: principal.tenantId,
        actorId: principal.userId,
        actorType: 'agent',
        tool: toolName,
        contract: contract.operation,
        contractVersion: contract.version,
        intentHash: claims.intentHash,
        argsRedacted: redactArgs(snapshot.normalizedArgs),
        evidenceDigest: revalidated.evidenceDigest,
        risk: claims.risk,
        reasons: revalidated.reasons,
        decision: 'allow',
        result: 'pending',
        subjectRef: preAuditSpec.subjectRef ?? null,
      },
      tx,
      now,
    );

    await tx.executionAttempt.update({
      where: { attemptId },
      data: { preAuditEventId: preAppended.eventId },
    });

    return {
      kind: 'execute',
      attemptId,
      contract,
      snapshot,
      claims,
      revalidated,
    };
  });
}

/**
 * 读取并发竞争留下的执行尝试。
 *
 * attempt 创建命中唯一约束时，本事务已经整体回滚（令牌与快照消费不会提交）。
 * 在新事务里先看幂等记录，再看尝试状态，映射规则与 Phase 1 完全一致
 * （包括 succeeded 时同一事务内重读幂等记录，见 attemptEnvelope）。
 */
async function resolveExistingAttempt(
  tenantId: string,
  toolName: string,
  idempotencyKey: string,
): Promise<Envelope | null> {
  return withTenantScope(tenantId, async (tx) => {
    const existing = await tx.idempotencyRecord.findFirst({
      where: { tenantId, toolName, idempotencyKey },
    });
    if (existing) return replayIdempotent(existing.response);

    const attempt = await tx.executionAttempt.findUnique({
      where: { tenantId_toolName_idempotencyKey: { tenantId, toolName, idempotencyKey } },
    });
    return attempt ? attemptEnvelope(tx, tenantId, toolName, idempotencyKey, attempt) : null;
  });
}

/**
 * 条件认领结算权：只有仍处于 executing/unknown 的尝试才能被本次调用结算。
 *
 * 对账（Task 4）与前台请求可能同时看到同一个未结算尝试；条件更新的原子性
 * 保证只有一个调用者能写入终态，另一个必须重放或返回冲突，不能覆盖结果。
 */
async function claimAttemptForSettlement(
  tx: PrismaTx,
  tenantId: string,
  attemptId: string,
  data: Prisma.ExecutionAttemptUpdateManyMutationInput,
): Promise<boolean> {
  const claimed = await tx.executionAttempt.updateMany({
    where: {
      attemptId,
      tenantId,
      status: { in: ['executing', 'unknown'] },
    },
    data,
  });
  return claimed.count === 1;
}

/**
 * 结果审计至多一次。
 *
 * 追加前检查 `resultAuditEventId`：对账可能已经补齐结果事件，重复追加会让
 * 同一次执行出现两条结果记录。事件 ID 仍保持确定性的 `${attemptId}:result`。
 */
async function ensureResultAudit(
  tx: PrismaTx,
  tenantId: string,
  attemptId: string,
  spec: Omit<AuditEventInput, 'eventId' | 'tenantId'>,
  now: Date,
): Promise<string> {
  const current = await tx.executionAttempt.findFirst({
    where: { attemptId, tenantId },
    select: { resultAuditEventId: true },
  });
  if (current?.resultAuditEventId) return current.resultAuditEventId;

  // 确定性事件 ID 让重复对账不会拉长链；若事件已经写过但 attempt 的指针
  // 意外缺失（例如历史数据或人工修复），补齐指针而不是再追加一条。
  const eventId = `${attemptId}:result`;
  const existingEvent = await tx.auditEvent.findFirst({
    where: { eventId, tenantId },
    select: { eventId: true },
  });
  if (existingEvent) {
    await tx.executionAttempt.update({
      where: { attemptId },
      data: { resultAuditEventId: existingEvent.eventId },
    });
    return existingEvent.eventId;
  }

  const appended = await auditChain.append({ eventId, tenantId, ...spec }, tx, now);
  await tx.executionAttempt.update({
    where: { attemptId },
    data: { resultAuditEventId: appended.eventId },
  });
  return appended.eventId;
}

/**
 * 条件结算失败时的响应。
 *
 * updateMany 命中 0 行说明另一个调用者（并发请求或对账）已经推进了终态：
 * 优先重放已提交的幂等记录，其次返回 attempt 中存储的信封；两者都没有时
 * 只能要求人工对账，绝不能伪造成功或覆盖已有结果。
 *
 * 导出用于单测直接覆盖三条优先级分支；不是公共 API。
 */
export async function settlementRacedEnvelope(
  tx: PrismaTx,
  tenantId: string,
  toolName: string,
  idempotencyKey: string,
  attemptId: string,
  traceId: string,
): Promise<Envelope> {
  const record = await tx.idempotencyRecord.findFirst({
    where: { tenantId, toolName, idempotencyKey },
  });
  if (record) return replayIdempotent(record.response);

  const current = await tx.executionAttempt.findFirst({ where: { attemptId, tenantId } });
  const stored = storedEnvelope(current?.result);
  if (stored) return replayIdempotent(stored);
  // 没抢到结算权且没有已存结果：按当前尝试状态映射。仍为 executing/unknown
  // 时必须返回与 Phase 1 相同的机器可识别错误码，而不是泛化为 CONFLICT。
  if (current) return existingAttemptEnvelope(current);

  return conflict('execution attempt was settled concurrently; reconciliation required', { traceId });
}

/** 结算成功：条件迁移 attempt succeeded + 确定性结果审计 + TEF 幂等记录，同一事务提交。 */
export async function settleSuccess(
  actor: SettlementActor,
  toolName: string,
  idempotencyKey: string,
  attempt: ExecutingAttempt,
  execResult: EffectsExecuteResult,
): Promise<Envelope> {
  const settledAt = actor.now ?? new Date();
  const auditEventId = `${attempt.attemptId}:result`;
  const order = execResult.refs.order as Record<string, unknown> | undefined;
  const normalizedArgs = attempt.snapshot.normalizedArgs as Record<string, unknown>;
  const response = ok(
    {
      orderId: order?.id ?? normalizedArgs.orderId ?? null,
      orderNo: order?.orderNo ?? null,
      status: order?.status ?? (attempt.contract.auditResult === 'compensated' ? 'cancelled' : null),
      totalAmount: order?.totalAmount ?? null,
      deposit: order?.deposit ?? null,
      balance: order?.balance ?? null,
      termsDays: order?.termsDays ?? null,
      depositPaymentId: (execResult.refs.depositPayment as Record<string, unknown> | undefined)?.id ?? null,
      balancePaymentId: (execResult.refs.balancePayment as Record<string, unknown> | undefined)?.id ?? null,
      ...(attempt.contract.auditResult === 'compensated' ? { compensated: true } : {}),
      idempotencyKey,
    },
    {
      risk: attempt.claims.risk,
      reasons: attempt.revalidated.reasons,
      auditId: auditEventId,
      traceId: actor.traceId,
    },
  );

  const auditSpec = attempt.contract.audit(
    attempt.snapshot.normalizedArgs as never,
    attempt.revalidated.evidence,
    execResult,
  );

  return withTenantScope(actor.tenantId, async (tx) => {
    const claimed = await claimAttemptForSettlement(tx, actor.tenantId, attempt.attemptId, {
      status: 'succeeded',
      result: response as unknown as Prisma.InputJsonValue,
      errorCode: null,
      errorMessage: null,
      settledAt,
    });
    if (!claimed) {
      return settlementRacedEnvelope(
        tx,
        actor.tenantId,
        toolName,
        idempotencyKey,
        attempt.attemptId,
        actor.traceId,
      );
    }

    const resultAuditEventId = await ensureResultAudit(
      tx,
      actor.tenantId,
      attempt.attemptId,
      {
        traceId: actor.traceId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        tool: toolName,
        contract: attempt.contract.operation,
        contractVersion: attempt.contract.version,
        intentHash: attempt.claims.intentHash,
        argsRedacted: redactArgs(attempt.snapshot.normalizedArgs),
        evidenceDigest: attempt.revalidated.evidenceDigest,
        risk: attempt.claims.risk,
        reasons: attempt.revalidated.reasons,
        decision: 'allow',
        result: attempt.contract.auditResult ?? 'success',
        subjectRef: auditSpec.subjectRef ?? null,
      },
      settledAt,
    );

    await tx.idempotencyRecord.create({
      data: {
        tenantId: actor.tenantId,
        toolName,
        idempotencyKey,
        status: 'completed',
        response: response as unknown as object,
        auditEventId: resultAuditEventId,
      },
    });

    return response;
  });
}

/**
 * 结算确定性失败。
 *
 * 进程内执行器的 INTERNAL 表示副作用事务已回滚，因此按确定失败处理：
 * attempt → failed，并写结果审计。CONFLICT 额外写幂等记录，让重复请求
 * 得到同一个失败响应；INTERNAL 不写幂等记录，避免把暂时性问题固化成成功语义。
 */
export async function settleFailure(
  actor: SettlementActor,
  toolName: string,
  idempotencyKey: string,
  failureResult: AuditResultType,
  attempt: ExecutingAttempt,
  code: 'CONFLICT' | 'INTERNAL',
  message: string,
): Promise<Envelope> {
  const settledAt = actor.now ?? new Date();
  // attempt 在这条路径上被原子推进为 failed；把该事实写进机读字段，调用方
  // 无需解析错误码或 message 就能判断“原尝试已确定失败，可以清理现场”。
  const failureData = { attemptId: attempt.attemptId, attemptStatus: 'failed' };
  const response =
    code === 'CONFLICT'
      ? conflict(message, { traceId: actor.traceId, data: failureData })
      : fail('INTERNAL', message, [], { data: failureData });
  const auditSpec = attempt.contract.audit(
    attempt.snapshot.normalizedArgs as never,
    attempt.revalidated.evidence,
    null,
  );

  return withTenantScope(actor.tenantId, async (tx) => {
    const claimed = await claimAttemptForSettlement(tx, actor.tenantId, attempt.attemptId, {
      status: 'failed',
      result: response as unknown as Prisma.InputJsonValue,
      errorCode: code,
      errorMessage: message,
      settledAt,
    });
    if (!claimed) {
      return settlementRacedEnvelope(
        tx,
        actor.tenantId,
        toolName,
        idempotencyKey,
        attempt.attemptId,
        actor.traceId,
      );
    }

    const resultAuditEventId = await ensureResultAudit(
      tx,
      actor.tenantId,
      attempt.attemptId,
      {
        traceId: actor.traceId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        tool: toolName,
        contract: attempt.contract.operation,
        contractVersion: attempt.contract.version,
        intentHash: attempt.claims.intentHash,
        argsRedacted: redactArgs(attempt.snapshot.normalizedArgs),
        evidenceDigest: attempt.revalidated.evidenceDigest,
        risk: attempt.claims.risk,
        reasons: [`${code}: ${message}`],
        decision: 'block',
        result: failureResult,
        subjectRef: auditSpec.subjectRef ?? null,
      },
      settledAt,
    );

    if (code === 'CONFLICT') {
      await tx.idempotencyRecord.create({
        data: {
          tenantId: actor.tenantId,
          toolName,
          idempotencyKey,
          status: 'completed',
          response: response as unknown as object,
          auditEventId: resultAuditEventId,
        },
      });
    }

    return response;
  });
}

/**
 * 结算未知：副作用可能已经提交，但调用方没有拿到确定结果。
 *
 * 不写结果审计与幂等记录：对账会按同一个 idempotencyKey 重新执行/确认，
 * 再用 `${attemptId}:result` 补齐结果事件。重复请求会被 Phase 1 的
 * executing/unknown 检查挡下，不会盲目重试。
 */
export async function settleUnknown(
  tenantId: string,
  attempt: Pick<ExecutingAttempt, 'attemptId'>,
  error: unknown,
): Promise<Envelope> {
  const message =
    error instanceof EffectsExecutionUnknownError
      ? error.message
      : 'effects execution outcome is unknown; reconciliation is required before retrying';

  try {
    await withTenantScope(tenantId, async (tx) => {
      // 只把尚未结算的尝试推进到 unknown；若对账已经抢先结算，不能覆盖其结果。
      await tx.executionAttempt.updateMany({
        where: {
          attemptId: attempt.attemptId,
          tenantId,
          status: { in: ['executing', 'unknown'] },
        },
        // UNKNOWN 不是确定性错误：不能写成 INTERNAL，否则会把“可能已提交”
        // 误标成“确定失败”，诱导调用方用新幂等键重试。
        data: { status: 'unknown', errorCode: 'UNKNOWN', errorMessage: message },
      });
    });
  } catch (settleError) {
    // 状态更新失败时尝试仍是 executing；对账同时扫描 executing 与 unknown，
    // 因此仍然可以收敛。绝不能把这里变成“确定失败”。
    console.error(
      '[tef.executeContract] failed to mark execution attempt unknown:',
      settleError instanceof Error ? settleError.message : settleError,
    );
  }

  return fail('EXECUTION_UNKNOWN', `${message}; retry with the same idempotency key after reconciliation`, [], {
    data: { attemptId: attempt.attemptId, retryWithSameKey: true },
  });
}

export async function executeContract(
  principal: Principal,
  args: { confirmation_token?: string; idempotency_key?: string },
  options: ContractWriteOptions,
  toolName: string,
  failureContractOperation: string,
  failureResult: AuditResultType,
): Promise<Envelope> {
  const token = args.confirmation_token;
  const idempotencyKey = args.idempotency_key;
  const now = options.now ?? new Date();

  if (!token || typeof token !== 'string') {
    return fail('VALIDATION_ERROR', `${toolName} requires confirmation_token`);
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return fail('VALIDATION_ERROR', `${toolName} requires idempotency_key`);
  }

  let phase1: Phase1Result | undefined;
  // Phase 1 提交是语义分水岭：提交前失败可以写“确定失败”审计；
  // 提交后副作用可能已经发生，任何失败审计都会与随后的对账结果矛盾。
  let phase1Committed = false;

  try {
    // 配置错误必须在消费令牌、创建执行尝试之前失败。
    if (!options.effectsExecutor) {
      throw new TefError('INTERNAL', 'EffectsExecutor is not configured');
    }

    try {
      phase1 = await runPhase1(principal, token, idempotencyKey, options, toolName, failureResult, now);
    } catch (error) {
      // 并发同 key 的两条路径：
      // - 不同令牌：attempt 唯一索引触发 P2002，本事务整体回滚；
      // - 同一令牌：输家阻塞在令牌条件更新上，等赢家提交 Phase 1 后得到
      //   “already been used”。这不是重放攻击，必须按已提交的 attempt 返回
      //   in-progress / 重放结果，而不是误报令牌重放。
      if (isUniqueConstraintError(error) || (isTefError(error) && error.code === 'CONFLICT')) {
        const raced = await resolveExistingAttempt(principal.tenantId, toolName, idempotencyKey);
        if (raced) return raced;
      }
      throw error;
    }

    if (!phase1) {
      throw new TefError('INTERNAL', 'phase 1 did not return an execution attempt');
    }
    if (phase1.kind === 'envelope') {
      return phase1.envelope;
    }

    // runPhase1 返回时租户事务已经提交；从这里开始副作用可能发生。
    phase1Committed = true;
    const executing = phase1;
    const settlementActor: SettlementActor = {
      tenantId: principal.tenantId,
      actorId: principal.userId,
      actorType: 'agent',
      traceId: options.traceId,
      // 结算时间取实际结算时刻，而不是请求开始时间：Phase 2 可能耗时较长，
      // 把 settledAt 与结果审计 ts 钉在请求开始会掩盖真实执行时长。
      // 仅在调用方显式注入时钟（测试/回放）时才使用固定值。
      now: options.now,
    };

    // Phase 2：外部副作用。执行器幂等域只含单一内部工具名，必须用
    // `toolName:key` 作用域，避免跨工具复用同一业务 key 时重放另一个操作。
    const executorIdempotencyKey = scopedExecutorIdempotencyKey(toolName, idempotencyKey);
    let execResult: EffectsExecuteResult;
    try {
      execResult = await options.effectsExecutor.execute({
        tenantId: principal.tenantId,
        idempotencyKey: executorIdempotencyKey,
        previewId: executing.snapshot.previewId,
        traceId: options.traceId,
        expectedEvidenceVersion: executing.snapshot.evidenceDigest,
        effects: executing.revalidated.effects,
      });
    } catch (error) {
      // 违反端口约定抛出的 EffectExecutionError 带确定性错误码；其余异常
      // （含 EffectsExecutionUnknownError/超时）都表示结果未知，交给对账收敛。
      if (error instanceof EffectExecutionError) {
        return settleFailure(
          settlementActor,
          toolName,
          idempotencyKey,
          failureResult,
          executing,
          error.code,
          error.message,
        );
      }
      return settleUnknown(principal.tenantId, executing, error);
    }

    // Phase 3：结算。
    if (execResult.ok) {
      return settleSuccess(settlementActor, toolName, idempotencyKey, executing, execResult);
    }

    const code = execResult.error?.code ?? 'INTERNAL';
    const message = execResult.error?.message ?? 'effects execution failed';
    return settleFailure(settlementActor, toolName, idempotencyKey, failureResult, executing, code, message);
  } catch (error) {
    if (phase1Committed && phase1?.kind === 'execute') {
      // Phase 1 已提交且后续步骤意外失败：副作用可能已经发生，尝试仍是
      // executing。这里写失败审计会在对账补写成功审计后自相矛盾；正确做法
      // 是把尝试标记为 unknown（或保留 executing），等待同一幂等键收敛。
      return settleUnknown(principal.tenantId, phase1, error);
    }

    await auditFailureOutOfTransaction(
      principal,
      options,
      now,
      toolName,
      failureContractOperation,
      error,
      failureResult,
    );
    if (error instanceof EffectExecutionError && error.code === 'CONFLICT') {
      return conflict(error.message, { traceId: options.traceId });
    }
    return errorToEnvelope(error);
  }
}

/**
 * 事务回滚会把审计事件一起带走，所以失败记录必须在事务外补写。
 * 否则一次失败的写入连"它失败过"都查不到，公理 I6 就破了。
 */
async function auditFailureOutOfTransaction(
  principal: Principal,
  options: ContractWriteBaseOptions,
  now: Date,
  tool: string,
  contractOperation: string,
  error: unknown,
  result: AuditResultType,
): Promise<void> {
  const code = isTefError(error) ? error.code : error instanceof EffectExecutionError ? error.code : 'INTERNAL';
  const message = error instanceof Error ? error.message : 'unknown error';
  try {
    await withTenantScope(principal.tenantId, async (tx) => {
      await auditChain.append(
        {
          traceId: options.traceId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          actorType: principal.clientKind === 'agent' ? 'agent' : 'human',
          tool,
          contract: contractOperation,
          contractVersion: '',
          intentHash: '',
          argsRedacted: {},
          evidenceDigest: '',
          risk: 'Block',
          reasons: [`${code}: ${message}`],
          decision: code === 'PERMISSION_DENIED' ? 'reject' : 'block',
          result,
          subjectRef: null,
        },
        tx,
        now,
      );
    });
  } catch {
    // 审计补写失败不能掩盖原始错误；此时业务事务已经回滚，没有副作用泄漏。
  }
}

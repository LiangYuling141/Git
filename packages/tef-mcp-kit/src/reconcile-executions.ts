import type { Prisma } from '@/generated/prisma';
import {
  EffectExecutionError,
  contractRegistry,
  riskFromDb,
} from '@lymtrix/tef-core';
import type {
  AuditResultType,
  Effect,
  EffectsExecuteResult,
  EffectsExecutor,
  RevalidateOutcome,
} from '@lymtrix/tef-core';
import { previewStore } from './preview-store';
import type { TokenClaims } from './token';
import { withTenantScope } from './tenant-scope';
import {
  scopedExecutorIdempotencyKey,
  settleFailure,
  settleSuccess,
  settleUnknown,
  type ExecutingAttempt,
  type SettlementActor,
} from './tools/contract';

/**
 * 执行尝试对账（Phase C Task 4）。
 *
 * 前台两阶段状态机在以下位置可能留下未结算的尝试：
 * - Phase 1 提交后进程崩溃、Phase 2 从未执行（status = executing）；
 * - 执行器提交后响应丢失/超时（status = unknown）；
 * - 副作用成功但 Phase 3 结算事务未提交（仍是 executing/unknown）。
 *
 * 对账按前台完全相同的执行器幂等键重放：
 * `scopedExecutorIdempotencyKey(attempt.toolName, attempt.idempotencyKey)`。
 * 因此副作用至多发生一次——执行器已有记录时返回首次结果，不会重复写库。
 *
 * 结算复用前台 Phase 3 的条件更新与审计助手：
 * - 只有 executing/unknown 能迁移到终态，绝不覆盖已结算结果；
 * - 结果审计使用确定性 `${attemptId}:result`，且先检查 `resultAuditEventId`；
 * - 幂等记录与结果审计在同一事务提交。
 *
 * kit 不依赖任何垂直包：契约通过 registry 按名取回，执行器由调用方注入。
 */

export interface ReconcileOptions {
  tenantId: string;
  effectsExecutor: EffectsExecutor;
  /** 判定时间基准；缺省为当前时间。 */
  now?: Date;
  /** executing 尝试的静默期：只有超过该时长未被更新才由对账接管。 */
  staleAfterMs?: number;
  /** 单次对账最多处理多少条尝试。 */
  limit?: number;
}

export interface ReconciliationReport {
  scanned: number;
  succeeded: number;
  failed: number;
  unknown: number;
}

/** executing 尝试的默认静默期：避开仍在正常执行中的前台请求。 */
export const DEFAULT_RECONCILE_STALE_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_RECONCILE_LIMIT = 100;

/** 对账审计的操作者标识：与用户/Agent 区分，便于回放时定位恢复动作。 */
export const RECONCILER_ACTOR_ID = 'system:reconciliation';

type AttemptStatus = 'executing' | 'succeeded' | 'failed' | 'unknown';
type ReconcileOutcome = 'succeeded' | 'failed' | 'unknown';

interface AttemptRow {
  attemptId: string;
  tenantId: string;
  traceId: string;
  previewId: string;
  contract: string;
  contractVersion: string;
  intentHash: string;
  toolName: string;
  idempotencyKey: string;
  status: AttemptStatus;
  risk: 'L0' | 'L1' | 'L2' | 'BLOCK';
  effects: Prisma.JsonValue;
  expectedEvidenceVersion: string | null;
}

/** 与前台一致：补偿契约的失败审计结果是 compensation_failed，其余为 failure。 */
function failureResultFor(attempt: ExecutingAttempt): AuditResultType {
  return attempt.contract.auditResult === 'compensated' ? 'compensation_failed' : 'failure';
}

/**
 * 从 attempt + 预览快照重建 Phase 3 所需的结算上下文。
 *
 * 快照不因执行而删除（只迁移 status），因此崩溃恢复后仍能取回被批准参数、
 * 证据与证据摘要。契约按 attempt 上持久化的版本取回，避免用新版本重算旧执行。
 * 任一依赖缺失时返回 null：无法构造可审计的结果，保持原状态交给人工处理。
 */
async function loadAttemptContext(row: AttemptRow): Promise<ExecutingAttempt | null> {
  return withTenantScope(row.tenantId, async (tx) => {
    const snapshot = await previewStore.load(row.tenantId, row.previewId, tx);
    if (!snapshot) return null;

    const contract = contractRegistry.get(row.contract, row.contractVersion);
    if (!contract) return null;

    const risk = riskFromDb(row.risk);
    const evidenceDigest = row.expectedEvidenceVersion ?? snapshot.evidenceDigest;
    const claims: TokenClaims = {
      tenantId: row.tenantId,
      userId: snapshot.userId,
      sessionId: snapshot.sessionId,
      previewId: row.previewId,
      intentHash: row.intentHash,
      contract: row.contract,
      contractVersion: row.contractVersion,
      risk,
      requiresApproval: risk === 'L2',
      issuedAt: snapshot.createdAt.toISOString(),
      expiresAt: snapshot.expiresAt.toISOString(),
    };

    const revalidated: Extract<RevalidateOutcome, { ok: true }> = {
      ok: true,
      params: snapshot.normalizedArgs,
      evidence: snapshot.evidence,
      risk,
      reasons: snapshot.reasons,
      effects: row.effects as unknown as Effect[],
      audit: contract.audit(snapshot.normalizedArgs, snapshot.evidence, null),
      evidenceDigest,
    };

    return { attemptId: row.attemptId, contract, snapshot, claims, revalidated };
  });
}

/** 结算结束后按数据库终态归类；条件更新竞争时以实际状态为准。 */
async function classifyStoredStatus(tenantId: string, attemptId: string): Promise<ReconcileOutcome> {
  try {
    const current = await withTenantScope(tenantId, (tx) =>
      tx.executionAttempt.findFirst({
        where: { attemptId, tenantId },
        select: { status: true },
      }),
    );
    if (current?.status === 'succeeded') return 'succeeded';
    if (current?.status === 'failed') return 'failed';
  } catch (error) {
    console.error(
      '[tef.reconcile] failed to read settled attempt status:',
      error instanceof Error ? error.message : error,
    );
  }
  return 'unknown';
}

/**
 * 执行结算并把异常收敛成报告分类。
 *
 * 单个尝试的结算失败（例如幂等记录唯一索引竞争）不能中断整批对账：
 * 记日志后读取实际终态，仍不明确则保持 unknown，等待下一轮。
 */
async function settleAndClassify(
  row: AttemptRow,
  settle: () => Promise<unknown>,
): Promise<ReconcileOutcome> {
  try {
    await settle();
  } catch (error) {
    console.error(
      `[tef.reconcile] settlement failed for attempt ${row.attemptId}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return classifyStoredStatus(row.tenantId, row.attemptId);
}

async function reconcileAttempt(
  row: AttemptRow,
  executor: EffectsExecutor,
  now: Date,
): Promise<ReconcileOutcome> {
  const attempt = await loadAttemptContext(row);
  if (!attempt) {
    console.error(
      `[tef.reconcile] attempt ${row.attemptId} cannot be reconstructed (preview ${row.previewId} or contract ${row.contract}@${row.contractVersion} missing); leaving it for manual reconciliation`,
    );
    return 'unknown';
  }

  const actor: SettlementActor = {
    tenantId: row.tenantId,
    actorId: RECONCILER_ACTOR_ID,
    actorType: 'system',
    traceId: row.traceId,
    now,
  };

  let execResult: EffectsExecuteResult;
  try {
    execResult = await executor.execute({
      tenantId: row.tenantId,
      // 与前台 Phase 2 完全一致：执行器幂等域按 toolName 作用域派生。
      idempotencyKey: scopedExecutorIdempotencyKey(row.toolName, row.idempotencyKey),
      previewId: row.previewId,
      traceId: row.traceId,
      expectedEvidenceVersion: row.expectedEvidenceVersion ?? undefined,
      effects: row.effects as unknown as Effect[],
    });
  } catch (error) {
    // 端口约定不抛业务错误；抛出的 EffectExecutionError 仍按确定性失败处理，
    // 其余异常（含 EffectsExecutionUnknownError/超时）表示结果仍未知。
    if (error instanceof EffectExecutionError) {
      return settleAndClassify(row, () =>
        settleFailure(
          actor,
          row.toolName,
          row.idempotencyKey,
          failureResultFor(attempt),
          attempt,
          error.code,
          error.message,
        ),
      );
    }
    try {
      await settleUnknown(row.tenantId, attempt, error);
    } catch (settleError) {
      console.error(
        `[tef.reconcile] failed to mark attempt ${row.attemptId} unknown:`,
        settleError instanceof Error ? settleError.message : settleError,
      );
    }
    return 'unknown';
  }

  if (execResult.ok) {
    return settleAndClassify(row, () =>
      settleSuccess(actor, row.toolName, row.idempotencyKey, attempt, execResult),
    );
  }

  const code = execResult.error?.code ?? 'INTERNAL';
  const message = execResult.error?.message ?? 'effects execution failed';
  return settleAndClassify(row, () =>
    settleFailure(
      actor,
      row.toolName,
      row.idempotencyKey,
      failureResultFor(attempt),
      attempt,
      code,
      message,
    ),
  );
}

/**
 * 对账入口：扫描超时的 executing 尝试与全部 unknown 尝试，按同一幂等键收敛。
 *
 * - 执行器成功 → 条件结算为 succeeded（结果审计 + 幂等记录）；
 * - 确定性失败 → 条件结算为 failed（失败审计，CONFLICT 额外写幂等记录）；
 * - 仍未知 → 保持/迁移到 unknown，等待下一轮。
 */
export async function reconcileExecutions(options: ReconcileOptions): Promise<ReconciliationReport> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_RECONCILE_STALE_AFTER_MS;
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const take = Math.max(1, options.limit ?? DEFAULT_RECONCILE_LIMIT);

  const rows = await withTenantScope(options.tenantId, (tx) =>
    tx.executionAttempt.findMany({
      where: {
        tenantId: options.tenantId,
        OR: [
          { status: 'unknown' },
          { status: 'executing', updatedAt: { lt: cutoff } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take,
      select: {
        attemptId: true,
        tenantId: true,
        traceId: true,
        previewId: true,
        contract: true,
        contractVersion: true,
        intentHash: true,
        toolName: true,
        idempotencyKey: true,
        status: true,
        risk: true,
        effects: true,
        expectedEvidenceVersion: true,
      },
    }),
  );

  const report: ReconciliationReport = {
    scanned: rows.length,
    succeeded: 0,
    failed: 0,
    unknown: 0,
  };

  for (const row of rows) {
    const outcome = await reconcileAttempt(row as AttemptRow, options.effectsExecutor, now);
    report[outcome] += 1;
  }

  return report;
}

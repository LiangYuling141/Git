import { createCreditOrderAdapters } from '@/contracts/credit-order';
import { registerCreditOrderContracts } from '@/contracts/credit-order';
import { auditChain } from '@/tef/audit-chain';
import { contractEngine } from '@/tef/contract-engine';
import { contractRegistry } from '@/tef/contract-registry';
import { TefError, isTefError } from '@/tef/errors';
import { executeEffects, EffectExecutionError } from '@/tef/effect-executor';
import { previewStore } from '@/tef/preview-store';
import { redactArgs } from '@/tef/redaction';
import { tokenStore } from '@/tef/token';
import { withTenantScope } from '@/tef/tenant-scope';
import type { Envelope, PrismaTx } from '@/tef/types';
import { conflict, errorToEnvelope, fail, needsConfirmation, ok } from '../envelope';
import { buildExecContext, type Principal } from '../principal';

/**
 * 预览与执行工具（L4）。
 *
 * 公理 I3：执行工具**只接受** confirmation_token + idempotency_key，
 * 不接受模型重新生成的业务参数。业务参数的唯一来源是预览快照。
 *
 * 整个执行在一个事务里：令牌消费、快照消费、契约重校验、副作用写入、
 * 审计追加、幂等记录，要么全部生效要么全部回滚。
 * 失败时审计事件在事务外补写——否则一次失败的写入会连自己的记录一起消失。
 */

export interface WriteOptions {
  traceId: string;
  secret: string;
  now?: Date;
}

const EXECUTE_TOOL = 'order.execute_create';
const PREVIEW_TOOL = 'order.preview_create';

registerCreditOrderContracts();

// -----------------------------------------------------------------------------
// order.preview_create
// -----------------------------------------------------------------------------

export async function orderPreviewCreate(
  principal: Principal,
  args: Record<string, unknown>,
  options: WriteOptions,
): Promise<Envelope> {
  const now = options.now ?? new Date();

  try {
    return await withTenantScope(principal.tenantId, async (tx) => {
      const ctx = await buildExecContext(principal, tx, { traceId: options.traceId, now });

      const contract = contractRegistry.get('create_order');
      if (!contract) {
        throw new TefError('INTERNAL', 'contract create_order is not registered');
      }

      const outcome = await contractEngine.preview(contract, args, ctx);

      if (outcome.blocked) {
        const appended = await auditChain.append(
          {
            traceId: options.traceId,
            tenantId: principal.tenantId,
            actorId: principal.userId,
            actorType: 'agent',
            tool: PREVIEW_TOOL,
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
          tool: PREVIEW_TOOL,
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
    await auditFailureOutOfTransaction(principal, options, now, PREVIEW_TOOL, error);
    return errorToEnvelope(error);
  }
}

// -----------------------------------------------------------------------------
// order.execute_create
// -----------------------------------------------------------------------------

export async function orderExecuteCreate(
  principal: Principal,
  args: { confirmation_token?: string; idempotency_key?: string },
  options: WriteOptions,
): Promise<Envelope> {
  const token = args.confirmation_token;
  const idempotencyKey = args.idempotency_key;
  const now = options.now ?? new Date();

  if (!token || typeof token !== 'string') {
    return fail('VALIDATION_ERROR', 'order.execute_create requires confirmation_token');
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return fail('VALIDATION_ERROR', 'order.execute_create requires idempotency_key');
  }

  try {
    return await withTenantScope(principal.tenantId, async (tx) => {
      // 幂等优先于一切：重复请求返回第一次的结果，不重复执行（§4.4）。
      const existing = await tx.idempotencyRecord.findFirst({
        where: { tenantId: principal.tenantId, toolName: EXECUTE_TOOL, idempotencyKey },
      });
      if (existing) {
        const replayed = existing.response as unknown as Envelope;
        return { ...replayed, data: { ...(replayed.data ?? {}), replayed: true } } as Envelope;
      }

      const ctx = await buildExecContext(principal, tx, { traceId: options.traceId, now });

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
            tool: EXECUTE_TOOL,
            contract: contract.operation,
            contractVersion: contract.version,
            intentHash: claims.intentHash,
            argsRedacted: redactArgs(snapshot.normalizedArgs),
            evidenceDigest: snapshot.evidenceDigest,
            risk: claims.risk,
            reasons: revalidated.reasons,
            decision: 'block',
            result: 'failure',
            subjectRef: null,
          },
          tx,
          now,
        );
        return conflict(revalidated.reasons.join('; '), {
          risk: claims.risk,
          reasons: revalidated.reasons,
          auditId: appended.eventId,
          traceId: options.traceId,
          error: {
            code: 'CONFLICT',
            message: `revalidation failed (${revalidated.cause}); the token was revoked, re-preview to continue`,
            checks: revalidated.failedChecks,
          },
        });
      }

      // 6. 声明式副作用在同一事务内执行；抛出即整体回滚（§4.5 事务内失败无需补偿契约）
      const adapters = createCreditOrderAdapters(tx, principal.tenantId, {
        previewId: snapshot.previewId,
        traceId: options.traceId,
      });
      const execResult = await executeEffects(revalidated.effects, adapters);

      const auditSpec = contract.audit(
        snapshot.normalizedArgs as never,
        revalidated.evidence,
        execResult,
      );

      // 7. 审计与写入同生共死：没有审计记录的写入不被允许提交
      const appended = await auditChain.append(
        {
          traceId: options.traceId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          actorType: 'agent',
          tool: EXECUTE_TOOL,
          contract: contract.operation,
          contractVersion: contract.version,
          intentHash: claims.intentHash,
          argsRedacted: redactArgs(snapshot.normalizedArgs),
          evidenceDigest: revalidated.evidenceDigest,
          risk: claims.risk,
          reasons: revalidated.reasons,
          decision: 'allow',
          result: 'success',
          subjectRef: auditSpec.subjectRef ?? null,
        },
        tx,
        now,
      );

      const order = execResult.refs.order as Record<string, unknown> | undefined;
      const response = ok(
        {
          orderId: order?.id ?? null,
          orderNo: order?.orderNo ?? null,
          status: order?.status ?? null,
          totalAmount: order?.totalAmount ?? null,
          deposit: order?.deposit ?? null,
          balance: order?.balance ?? null,
          termsDays: order?.termsDays ?? null,
          depositPaymentId: (execResult.refs.depositPayment as Record<string, unknown> | undefined)?.id ?? null,
          balancePaymentId: (execResult.refs.balancePayment as Record<string, unknown> | undefined)?.id ?? null,
          idempotencyKey,
        },
        {
          risk: claims.risk,
          reasons: revalidated.reasons,
          auditId: appended.eventId,
          traceId: options.traceId,
        },
      );

      await tx.idempotencyRecord.create({
        data: {
          tenantId: principal.tenantId,
          toolName: EXECUTE_TOOL,
          idempotencyKey,
          status: 'completed',
          response: response as unknown as object,
          auditEventId: appended.eventId,
        },
      });

      return response;
    });
  } catch (error) {
    await auditFailureOutOfTransaction(principal, options, now, EXECUTE_TOOL, error);
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
  options: WriteOptions,
  now: Date,
  tool: string,
  error: unknown,
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
          contract: 'create_order',
          contractVersion: '',
          intentHash: '',
          argsRedacted: {},
          evidenceDigest: '',
          risk: 'Block',
          reasons: [`${code}: ${message}`],
          decision: code === 'PERMISSION_DENIED' ? 'reject' : 'block',
          result: 'failure',
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

export type { PrismaTx };

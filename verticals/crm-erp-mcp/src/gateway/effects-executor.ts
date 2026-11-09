import {
  EffectExecutionError,
  executeEffects,
  type EffectsExecuteRequest,
  type EffectsExecuteResult,
  type EffectsExecutor,
} from '@lymtrix/tef-core';
import { withTenantScope } from '@lymtrix/tef-mcp-kit/tenant-scope';
import { createCreditOrderAdapters } from '../contracts/credit-order';

/**
 * CRM 的进程内 effects 执行器（Phase C Task 2）。
 *
 * 这是 `EffectsExecutor` 端口的默认实现：状态机与内部 HTTP 网关都通过它执行
 * 声明式 effects，从而复用同一套事务、幂等、重放与错误映射语义。
 *
 * 幂等记录与 effects 在同一个 withTenantScope 事务内提交：effects 失败时事务
 * 回滚，幂等记录不会落库，调用方可以用同一个 idempotencyKey 安全重试；重复
 * key 直接返回首次响应，不重新执行 effects（docs/technical/14-unified-architecture.md §4.4）。
 * 并发同 key 时后提交者命中唯一索引 P2002，整个事务回滚，再由新事务读取先提交者
 * 的记录按重放返回，调用方无需感知竞态。
 *
 * 端口约定：不向调用方抛业务错误。EffectExecutionError 的 CONFLICT / INTERNAL
 * 与未知异常都收敛为结构化结果，未知异常只返回通用文案，避免泄露 SQL 或堆栈。
 */

const TOOL_NAME = 'internal.effects.execute';

function structuredFailure(
  code: 'CONFLICT' | 'INTERNAL',
  message: string,
): EffectsExecuteResult {
  return { ok: false, refs: {}, error: { code, message } };
}

/** 与 executeContract 口径一致：重放返回首次响应并显式标记 replayed。 */
function replayResponse(record: { response: unknown }): EffectsExecuteResult {
  const firstResponse =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : {};
  return { ...firstResponse, replayed: true } as EffectsExecuteResult;
}

/** Prisma 唯一约束冲突（P2002）。并发同 key 的幂等插入会命中这里。 */
function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

async function findReplayRecord(
  tenantId: string,
  idempotencyKey: string,
): Promise<{ response: unknown } | null> {
  return withTenantScope(tenantId, (tx) =>
    tx.idempotencyRecord.findFirst({
      where: { tenantId, toolName: TOOL_NAME, idempotencyKey },
    }),
  );
}

/**
 * 在租户作用域事务内执行 effects。
 *
 * 抛出 EffectExecutionError 或 Prisma 错误由调用方统一收口——这里不吞异常，
 * 事务回滚语义才能与抽取前的路由保持一致。
 */
async function executeWithinTenantScope(
  input: EffectsExecuteRequest,
): Promise<EffectsExecuteResult> {
  return withTenantScope(input.tenantId, async (tx) => {
    // 幂等优先于一切：同一 key 的重复请求只返回首次结果，不重复执行。
    // RLS 的 app.tenant_id 已由 withTenantScope 设好，显式 tenantId 是第二道防线。
    const existing = await tx.idempotencyRecord.findFirst({
      where: {
        tenantId: input.tenantId,
        toolName: TOOL_NAME,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (existing) {
      return replayResponse(existing);
    }

    const adapters = createCreditOrderAdapters(tx, input.tenantId, {
      // 端口类型要求字符串，但内部 HTTP 网关的 schema 允许省略 previewId/traceId。
      // 空串归一为 null，保持抽取前 `previewId ?? null` 写入订单元数据的行为。
      previewId: input.previewId || null,
      traceId: input.traceId || null,
    });
    const result = await executeEffects(input.effects, adapters);

    const response: EffectsExecuteResult = { ok: true, refs: result.refs };
    await tx.idempotencyRecord.create({
      data: {
        tenantId: input.tenantId,
        toolName: TOOL_NAME,
        idempotencyKey: input.idempotencyKey,
        status: 'completed',
        response: response as unknown as object,
      },
    });
    return response;
  });
}

/** 执行一批声明式 effects；业务失败以 `{ ok:false, error }` 返回，不抛出。 */
export async function executeCrmEffectsInProcess(
  input: EffectsExecuteRequest,
): Promise<EffectsExecuteResult> {
  try {
    return await executeWithinTenantScope(input);
  } catch (error) {
    if (error instanceof EffectExecutionError) {
      return structuredFailure(error.code, error.message);
    }
    if (isUniqueConstraintError(error)) {
      // 并发同 key：两个事务都没读到幂等记录，先提交者成功，后提交者在
      // 唯一索引上得到 P2002，整个事务（包括 effects）回滚。读取先提交者的
      // 记录，按正常重放返回。
      try {
        const replay = await findReplayRecord(input.tenantId, input.idempotencyKey);
        if (replay) {
          return replayResponse(replay);
        }
      } catch (replayError) {
        console.error(
          '[internal.effects.execute] replay lookup failed:',
          replayError instanceof Error ? replayError.message : replayError,
        );
      }
      // 记录仍不存在说明 P2002 不是幂等插入造成的；按内部错误处理，
      // 不能把竞态当成成功响应返回。
      console.error('[internal.effects.execute] unique constraint without idempotency record');
      return structuredFailure('INTERNAL', 'internal gateway error');
    }
    // 不把内部异常信息返回给调用方，避免泄露 SQL、堆栈或实现细节。
    console.error(
      '[internal.effects.execute] unhandled error:',
      error instanceof Error ? error.message : error,
    );
    return structuredFailure('INTERNAL', 'internal gateway error');
  }
}

/** 构造端口实现；状态机与内部网关通过依赖注入拿到同一个语义。 */
export function createInProcessCrmEffectsExecutor(): EffectsExecutor {
  return { execute: executeCrmEffectsInProcess };
}

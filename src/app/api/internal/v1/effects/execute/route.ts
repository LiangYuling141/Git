import { NextResponse } from 'next/server';
import { z } from 'zod';
import { EffectExecutionError, executeEffects } from '@lymtrix/tef-core';
import { createCreditOrderAdapters } from '@lymtrix/vertical-crm-erp';
import { authorizeInternalRequest, internalAuthStatus } from '@/lib/internal-auth';
import { withTenantScope } from '@/tef/tenant-scope';

/**
 * 内部 effects 网关：业务 MCP 跨服务执行声明式副作用。
 *
 * 与 query 网关共用服务令牌鉴权。每批 effects 与幂等记录在同一个
 * withTenantScope 事务内提交：effects 失败时事务回滚，幂等记录不会落库，
 * 调用方可以用同一个 idempotencyKey 安全重试；重复 key 直接返回首次响应，
 * 不重新执行 effects（docs/technical/14-unified-architecture.md §4.4）。
 *
 * entity / type 是垂直白名单：未知组合在触库前被 zod 拒绝，避免通过
 * 任意实体名调用到未授权的适配器。
 */

const TOOL_NAME = 'internal.effects.execute';

/**
 * payload 里的 tenantId / id 是越权字段：update 适配器会把 payload 直接展开进
 * Prisma data，若不在这里拒绝，调用方就能改写租户归属或主键。create 同样拒绝，
 * 主键与租户只能由服务端事务上下文决定。
 */
const effectSchema = z
  .object({
    type: z.enum(['create', 'update', 'reserve', 'release']),
    entity: z.enum(['order', 'payment', 'product', 'customer']),
    as: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
    target: z.string().optional(),
    increment: z.record(z.string(), z.number()).optional(),
    bind: z.record(z.string(), z.object({ fromRef: z.string(), field: z.string() })).optional(),
  })
  .superRefine((effect, ctx) => {
    for (const key of ['tenantId', 'id'] as const) {
      if (Object.prototype.hasOwnProperty.call(effect.payload, key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', key],
          message: `payload.${key} is not allowed; tenant and primary key are server-controlled`,
        });
      }
      // bind 会把前序 refs 的字段值写进 payload；若允许绑定 tenantId / id，
      // 越权字段会在执行期绕过 payload 校验，因此必须在入口一并拒绝。
      for (const [bindKey, binding] of Object.entries(effect.bind ?? {})) {
        if (binding.field === key) {
          ctx.addIssue({
            code: 'custom',
            path: ['bind', bindKey, 'field'],
            message: `bind.${bindKey}.field cannot be ${key}; tenant and primary key are server-controlled`,
          });
        }
      }
    }
  });

const bodySchema = z.object({
  tenantId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  previewId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  // B2 只接受该字段；证据版本比较与 CONFLICT 语义在 Phase C 落地。
  expectedEvidenceVersion: z.string().min(1).optional(),
  // 空 effects 批次没有业务意义，只会生成无用的幂等记录；直接判为非法请求。
  effects: z.array(effectSchema).min(1),
});

function structuredError(
  code: 'VALIDATION_ERROR' | 'CONFLICT' | 'INTERNAL',
  message: string,
  status: number,
): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/** 与 executeContract 口径一致：重放返回首次响应并显式标记 replayed。 */
function replayResponse(record: { response: unknown }): Record<string, unknown> {
  const firstResponse =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : {};
  return { ...firstResponse, replayed: true };
}

/** Prisma 唯一约束冲突（P2002）。并发同 key 的幂等插入会命中这里。 */
function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError }, { status: internalAuthStatus(authError) });
  }

  // 默认关闭：Phase C 接入预览、确认令牌与审计前，不允许这条写入通道在
  // 生产被误启用。通过服务令牌鉴权后仍返回 404，避免向调用方暴露端点存在；
  // 启用需要显式设置 TEF_CRM_EFFECTS_ENABLED=1。
  if (process.env.TEF_CRM_EFFECTS_ENABLED !== '1') {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return structuredError('VALIDATION_ERROR', parsed.error.message, 400);
  }

  const { tenantId, idempotencyKey, previewId, traceId, effects } = parsed.data;

  try {
    const body = await withTenantScope(tenantId, async (tx) => {
      // 幂等优先于一切：同一 key 的重复请求只返回首次结果，不重复执行。
      // RLS 的 app.tenant_id 已由 withTenantScope 设好，显式 tenantId 是第二道防线。
      const existing = await tx.idempotencyRecord.findFirst({
        where: { tenantId, toolName: TOOL_NAME, idempotencyKey },
      });
      if (existing) {
        return replayResponse(existing);
      }

      const adapters = createCreditOrderAdapters(tx, tenantId, {
        previewId: previewId ?? null,
        traceId: traceId ?? null,
      });
      const result = await executeEffects(effects, adapters);

      const response = { ok: true, refs: result.refs };
      await tx.idempotencyRecord.create({
        data: {
          tenantId,
          toolName: TOOL_NAME,
          idempotencyKey,
          status: 'completed',
          response: response as unknown as object,
        },
      });
      return response;
    });

    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof EffectExecutionError) {
      return structuredError(error.code, error.message, error.code === 'CONFLICT' ? 409 : 500);
    }
    if (isUniqueConstraintError(error)) {
      // 并发同 key：两个事务都没读到幂等记录，先提交者成功，后提交者在
      // 唯一索引上得到 P2002，整个事务（包括 effects）回滚。换一个新事务
      // 读取先提交者的记录，按正常重放返回，调用方无需感知竞态。
      try {
        const replay = await withTenantScope(tenantId, (tx) =>
          tx.idempotencyRecord.findFirst({
            where: { tenantId, toolName: TOOL_NAME, idempotencyKey },
          }),
        );
        if (replay) {
          return NextResponse.json(replayResponse(replay));
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
      return structuredError('INTERNAL', 'internal gateway error', 500);
    }
    // 不把内部异常信息返回给调用方，避免泄露 SQL、堆栈或实现细节。
    console.error('[internal.effects.execute] unhandled error:', error instanceof Error ? error.message : error);
    return structuredError('INTERNAL', 'internal gateway error', 500);
  }
}

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

const effectSchema = z.object({
  type: z.enum(['create', 'update', 'reserve', 'release']),
  entity: z.enum(['order', 'payment', 'product', 'customer']),
  as: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
  target: z.string().optional(),
  increment: z.record(z.string(), z.number()).optional(),
  bind: z.record(z.string(), z.object({ fromRef: z.string(), field: z.string() })).optional(),
});

const bodySchema = z.object({
  tenantId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  previewId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  // B2 只接受该字段；证据版本比较与 CONFLICT 语义在 Phase C 落地。
  expectedEvidenceVersion: z.string().optional(),
  effects: z.array(effectSchema),
});

function structuredError(
  code: 'VALIDATION_ERROR' | 'CONFLICT' | 'INTERNAL',
  message: string,
  status: number,
): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError }, { status: internalAuthStatus(authError) });
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
        return existing.response;
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
    // 不把内部异常信息返回给调用方，避免泄露 SQL、堆栈或实现细节。
    console.error('[internal.effects.execute] unhandled error:', error instanceof Error ? error.message : error);
    return structuredError('INTERNAL', 'internal gateway error', 500);
  }
}

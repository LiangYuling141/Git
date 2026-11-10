import { NextResponse } from 'next/server';
import { EffectsExecutionUnknownError } from '@lymtrix/tef-core';
import { executeCrmEffectsInProcess } from '@lymtrix/vertical-crm-erp';
import { effectsRequestSchema } from '@/lib/internal-effects-schema';
import { authorizeInternalRequest, internalAuthStatus } from '@/lib/internal-auth';

/**
 * 内部 effects 网关：业务 MCP 跨服务执行声明式副作用。
 *
 * 与 query 网关共用服务令牌鉴权。鉴权、功能开关与 zod 校验通过后，事务、
 * 幂等记录、重放与 effects 执行全部委托给垂直包的 `executeCrmEffectsInProcess`
 * （`EffectsExecutor` 端口的进程内 CRM 实现），保证这条 HTTP 通道与 MCP 工具链
 * 复用同一套执行语义（docs/technical/14-unified-architecture.md §4.4）。
 *
 * entity / type 白名单与越权字段守卫集中在 @/lib/internal-effects-schema：
 * 未知组合在触库前被 zod 拒绝，避免通过任意实体名调用到未授权的适配器。
 */

function structuredError(
  code: 'VALIDATION_ERROR' | 'EXECUTION_UNKNOWN',
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

  // 默认关闭：B3 完成跨服务预览、确认令牌与审计接线前，不允许这条写入通道
  // 在生产被误启用。通过服务令牌鉴权后仍返回 404，避免向调用方暴露端点存在；
  // 启用需要显式设置 TEF_CRM_EFFECTS_ENABLED=1。
  if (process.env.TEF_CRM_EFFECTS_ENABLED !== '1') {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const parsed = effectsRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return structuredError('VALIDATION_ERROR', parsed.error.message, 400);
  }

  const { tenantId, idempotencyKey, previewId, traceId, expectedEvidenceVersion, effects } =
    parsed.data;

  let result: Awaited<ReturnType<typeof executeCrmEffectsInProcess>>;
  try {
    result = await executeCrmEffectsInProcess({
      tenantId,
      idempotencyKey,
      // schema 允许省略这两个字段，端口类型要求字符串；空串由执行器归一为 null，
      // 与抽取前适配器收到的 `previewId ?? null` 完全一致。
      previewId: previewId ?? '',
      traceId: traceId ?? '',
      expectedEvidenceVersion,
      effects,
    });
  } catch (error) {
    // 执行器无法确认副作用是否已提交（超时、连接中断、结算竞争读取失败）。
    // 必须返回结构化的 EXECUTION_UNKNOWN + 503，让调用方把尝试收敛为 unknown
    // 并用同一幂等键对账；若退化成 500/INTERNAL，调用方可能误判为确定失败。
    if (error instanceof EffectsExecutionUnknownError) {
      return structuredError('EXECUTION_UNKNOWN', error.message, 503);
    }
    throw error;
  }

  if (result.ok) {
    return NextResponse.json(result);
  }

  // 失败响应保持抽取前的形状：不返回 refs，只返回结构化错误。
  // 未知内部错误已在执行器内收敛为通用文案，不会泄露实现细节。
  const error = result.error ?? { code: 'INTERNAL' as const, message: 'internal gateway error' };
  return NextResponse.json(
    { ok: false, error },
    { status: error.code === 'CONFLICT' ? 409 : 500 },
  );
}

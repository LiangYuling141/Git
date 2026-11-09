import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TefError } from '@lymtrix/tef-core';
import { withTenantScope } from '@/tef/tenant-scope';
import { createPrismaCrmGateway } from '@lymtrix/vertical-crm-erp';
import { authorizeInternalRequest, internalAuthStatus } from '@/lib/internal-auth';
import { parseInternalQuery } from '@/lib/internal-query-schema';

/**
 * 内部 query 网关：业务 MCP 的 HttpCrmGateway 跨服务读取 CRM 证据。
 *
 * tenantId 以请求体为准，网关闭包绑定同一租户；每条查询都先进入
 * withTenantScope 设置 RLS 会话变量，再由网关显式带 tenantId 过滤，
 * 形成应用层与数据库层两道隔离。operation 与 params 在触库前按白名单校验，
 * 未知 operation 或缺失业务标识直接 400，避免 Prisma 忽略 undefined 后返回任意数据。
 */

const bodySchema = z.object({
  tenantId: z.string().min(1),
  operation: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** TefError 的稳定错误码到 HTTP 状态码的映射；未列出的错误码按 500 处理。 */
const STATUS_BY_ERROR_CODE: Partial<Record<TefError['code'], number>> = {
  VALIDATION_ERROR: 400,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

function errorResponse(error: unknown): NextResponse {
  if (error instanceof TefError) {
    const status = STATUS_BY_ERROR_CODE[error.code];
    if (status !== undefined) {
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
  }
  // 不把内部异常信息返回给调用方，避免泄露 SQL、堆栈或实现细节。
  return NextResponse.json({ error: 'INTERNAL', message: 'internal gateway error' }, { status: 500 });
}

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError }, { status: internalAuthStatus(authError) });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', message: parsed.error.message }, { status: 400 });
  }

  const { tenantId, operation, params } = parsed.data;
  const query = parseInternalQuery(operation, params);
  if (query.status === 'invalid') {
    return NextResponse.json({ error: 'VALIDATION_ERROR', message: query.message }, { status: 400 });
  }

  try {
    const data = await withTenantScope(tenantId, (tx) => {
      const gateway = createPrismaCrmGateway(tx, tenantId);
      return gateway.query({ tenantId, operation: query.operation, params: query.params });
    });
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenantScope } from '@/tef/tenant-scope';
import { createPrismaCrmGateway } from '@lymtrix/vertical-crm-erp';
import { authorizeInternalRequest, internalAuthStatus } from '@/lib/internal-auth';

/**
 * 内部 query 网关：业务 MCP 的 HttpCrmGateway 跨服务读取 CRM 证据。
 *
 * tenantId 以请求体为准，网关闭包绑定同一租户；每条查询都先进入
 * withTenantScope 设置 RLS 会话变量，再由网关显式带 tenantId 过滤，
 * 形成应用层与数据库层两道隔离。未知 operation 由垂直网关拒绝。
 */

const bodySchema = z.object({
  tenantId: z.string().min(1),
  operation: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

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
  try {
    const data = await withTenantScope(tenantId, (tx) => {
      const gateway = createPrismaCrmGateway(tx, tenantId);
      return gateway.query({ tenantId, operation, params });
    });
    return NextResponse.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'query failed';
    return NextResponse.json({ error: 'QUERY_FAILED', message }, { status: 400 });
  }
}

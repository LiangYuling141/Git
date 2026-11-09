// 内部 HTTP 网关的服务令牌鉴权。
//
// 只有持有 TEF_CRM_SERVICE_TOKEN 的调用方（业务 MCP 的 HttpCrmGateway）
// 才能访问 /api/internal/v1/*。未配置令牌时 fail-closed：返回 503 而不是放行，
// 避免部署时漏配环境变量把内部网关变成匿名可读。
export function authorizeInternalRequest(request: Request): string | null {
  const expected = process.env.TEF_CRM_SERVICE_TOKEN;
  if (!expected) return 'TEF_CRM_SERVICE_TOKEN is not configured';
  const header = request.headers.get('authorization') ?? '';
  if (header !== `Bearer ${expected}`) return 'unauthorized';
  return null;
}

export function internalAuthStatus(message: string): number {
  return message === 'unauthorized' ? 401 : 503;
}

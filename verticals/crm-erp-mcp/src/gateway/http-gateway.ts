import { TefError, type ErrorCode } from '@lymtrix/tef-core';
import type {
  CrmBusinessGateway,
  CustomerRecord,
  CreditRecord,
  OrderRecord,
  ProductRecord,
} from './types';
import { CRM_QUERY } from './types';

/**
 * 跨服务业务网关：把垂直查询翻译成 CRM 内部 HTTP 调用。
 *
 * 业务 MCP 不持有业务库凭据，只持有服务令牌；所有查询都显式带 tenantId，
 * 并在发请求前与本网关闭包绑定的租户比对，防止一次参数错误变成跨租户读取。
 */

export interface HttpCrmGatewayOptions {
  baseUrl: string;
  serviceToken: string;
  tenantId: string;
}

/** 内部网关与 CRM 同机房，10 秒足够；避免 CRM 挂起时调用方无限等待。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 内部网关会返回的错误码；其余一律按 INTERNAL 处理，避免透传未知语义。 */
const MAPPED_ERROR_CODES: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
]);

/**
 * 去掉 `undefined` 与空字符串参数。
 *
 * MCP 查询工具会把缺省字段规范成 `''`（customer.search 的 name/phone、
 * order.get 的 orderId），而内部路由的 zod schema 对业务标识使用 `min(1)`。
 * 原样透传会把“字段缺省”误判成“字段非法”并返回 400。只清理 `undefined`
 * 与 `''`，保留 `0`、`false` 与空数组等合法值。
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== ''),
  );
}

/** 把内部网关的错误响应映射为带稳定错误码的 TefError。 */
function toTefError(payload: unknown, status: number): TefError {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const message =
    typeof body.message === 'string' && body.message ? body.message : `CRM gateway error ${status}`;
  const code =
    typeof body.error === 'string' && MAPPED_ERROR_CODES.has(body.error)
      ? (body.error as ErrorCode)
      : 'INTERNAL';
  return new TefError(code, message);
}

export function createHttpCrmGateway(options: HttpCrmGatewayOptions): CrmBusinessGateway {
  const { baseUrl, serviceToken, tenantId } = options;
  if (!baseUrl) throw new TefError('INTERNAL', 'TEF_CRM_API_BASE is not configured');
  if (!serviceToken) throw new TefError('INTERNAL', 'TEF_CRM_SERVICE_TOKEN is not configured');
  if (!tenantId) throw new TefError('INTERNAL', 'HttpCrmGateway tenantId is not configured');

  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TefError('INTERNAL', `CRM gateway request failed: ${detail}`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw toTefError(payload, response.status);
    }
    return payload as T;
  };

  const assertTenant = (inputTenant: string): void => {
    if (inputTenant !== tenantId) throw new TefError('PERMISSION_DENIED', 'gateway tenant mismatch');
  };

  const gateway = {
    async query<T>(input: { tenantId: string; operation: string; params: Record<string, unknown> }): Promise<T> {
      assertTenant(input.tenantId);
      const result = await call<{ data: T }>('/api/internal/v1/query', {
        tenantId: input.tenantId,
        operation: input.operation,
        params: sanitizeParams(input.params),
      });
      return result.data;
    },
    searchCustomers(input: { tenantId: string; name?: string; phone?: string; limit?: number }) {
      return gateway.query<CustomerRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.customerSearch, params: input });
    },
    getCustomer(input: { tenantId: string; customerId: string }) {
      return gateway.query<CustomerRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.customerGet, params: input });
    },
    getCredit(input: { tenantId: string; customerId: string }) {
      return gateway.query<CreditRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.creditGet, params: input });
    },
    getProducts(input: { tenantId: string; skus: string[] }) {
      return gateway.query<ProductRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.productsGet, params: input });
    },
    searchProducts(input: { tenantId: string; term?: string }) {
      return gateway.query<ProductRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.productsSearch, params: input });
    },
    getOrder(input: { tenantId: string; orderId?: string; orderNo?: string }) {
      return gateway.query<OrderRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.orderGet, params: input });
    },
    async executeEffects(): Promise<never> {
      throw new TefError('INTERNAL', 'HttpCrmGateway.executeEffects is implemented in Task 4');
    },
  } as CrmBusinessGateway;

  return gateway;
}

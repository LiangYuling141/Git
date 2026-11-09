import { TefError } from '@lymtrix/tef-core';
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

export function createHttpCrmGateway(options: HttpCrmGatewayOptions): CrmBusinessGateway {
  const { baseUrl, serviceToken, tenantId } = options;
  if (!serviceToken) throw new TefError('INTERNAL', 'TEF_CRM_SERVICE_TOKEN is not configured');

  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new TefError('INTERNAL', payload.message ?? `CRM gateway error ${response.status}`);
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
        params: input.params,
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
      throw new TefError('INTERNAL', 'HttpCrmGateway.executeEffects is implemented in Task 3');
    },
  } as CrmBusinessGateway;

  return gateway;
}

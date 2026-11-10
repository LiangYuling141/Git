import type { EffectsExecuteRequest, EffectsExecuteResult } from '@lymtrix/tef-core';
import {
  CRM_QUERY,
  type CrmBusinessGateway,
  type CreditRecord,
  type CustomerRecord,
  type OrderRecord,
  type ProductRecord,
} from '@lymtrix/vertical-crm-erp';
import type { EvalSample } from './sample';

type Fixtures = EvalSample['fixtures'];

/**
 * 评测用业务网关：只读冻结的业务证据，不访问数据库。
 * executeEffects 只记录调用，评测不执行真实副作用。
 */
export class FixtureCrmGateway implements CrmBusinessGateway {
  readonly calls: string[] = [];

  constructor(private readonly fixtures: Fixtures) {}

  async searchCustomers(input: {
    tenantId: string;
    name?: string;
    phone?: string;
    limit?: number;
  }): Promise<CustomerRecord[]> {
    this.calls.push('searchCustomers');
    const name = input.name?.trim().toLowerCase();
    const phone = input.phone?.trim();
    const rows = this.fixtures.customers.filter((customer) => {
      const nameHit = name ? customer.name.toLowerCase().includes(name) : false;
      const phoneHit = phone ? customer.phone.includes(phone) : false;
      return nameHit || phoneHit;
    });
    return rows.slice(0, input.limit ?? 10);
  }

  async getCustomer(input: { tenantId: string; customerId: string }): Promise<CustomerRecord | null> {
    this.calls.push('getCustomer');
    return this.fixtures.customers.find((customer) => customer.id === input.customerId) ?? null;
  }

  async getCredit(input: { tenantId: string; customerId: string }): Promise<CreditRecord | null> {
    this.calls.push('getCredit');
    const customer = await this.getCustomer(input);
    if (!customer) return null;
    const openOrders = this.fixtures.orders
      .filter(
        (order) =>
          order.customerId === input.customerId &&
          order.balance > 0 &&
          order.status !== 'cancelled' &&
          order.status !== 'completed',
      )
      .map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        balance: order.balance,
        termsDays: order.termsDays,
        status: order.status,
        createdAt: order.createdAt,
      }));
    return { customer, openOrders };
  }

  async getProducts(input: { tenantId: string; skus: string[] }): Promise<ProductRecord[]> {
    this.calls.push('getProducts');
    const skus = new Set(input.skus);
    return this.fixtures.products.filter((product) => skus.has(product.sku));
  }

  async searchProducts(input: { tenantId: string; term?: string }): Promise<ProductRecord[]> {
    this.calls.push('searchProducts');
    const term = input.term?.trim().toLowerCase();
    if (!term) return this.fixtures.products;
    return this.fixtures.products.filter(
      (product) =>
        product.name.toLowerCase().includes(term) || product.sku.toLowerCase().includes(term),
    );
  }

  async getOrder(input: {
    tenantId: string;
    orderId?: string;
    orderNo?: string;
  }): Promise<OrderRecord | null> {
    this.calls.push('getOrder');
    return (
      this.fixtures.orders.find(
        (order) =>
          (input.orderId !== undefined && order.id === input.orderId) ||
          (input.orderNo !== undefined && order.orderNo === input.orderNo),
      ) ?? null
    );
  }

  async query<T = unknown>(input: {
    tenantId: string;
    operation: string;
    params: Record<string, unknown>;
  }): Promise<T> {
    switch (input.operation) {
      case CRM_QUERY.customerSearch:
        return (await this.searchCustomers({
          tenantId: input.tenantId,
          ...input.params,
        })) as T;
      case CRM_QUERY.customerGet:
        return (await this.getCustomer({
          tenantId: input.tenantId,
          customerId: String(input.params.customerId ?? ''),
        })) as T;
      case CRM_QUERY.creditGet:
        return (await this.getCredit({
          tenantId: input.tenantId,
          customerId: String(input.params.customerId ?? ''),
        })) as T;
      case CRM_QUERY.productsGet:
        return (await this.getProducts({
          tenantId: input.tenantId,
          skus: Array.isArray(input.params.skus) ? (input.params.skus as string[]) : [],
        })) as T;
      case CRM_QUERY.productsSearch:
        return (await this.searchProducts({
          tenantId: input.tenantId,
          term: typeof input.params.term === 'string' ? input.params.term : undefined,
        })) as T;
      case CRM_QUERY.orderGet:
        return (await this.getOrder({
          tenantId: input.tenantId,
          orderId: typeof input.params.orderId === 'string' ? input.params.orderId : undefined,
          orderNo: typeof input.params.orderNo === 'string' ? input.params.orderNo : undefined,
        })) as T;
      default:
        throw new Error(`unsupported query operation: ${input.operation}`);
    }
  }

  async executeEffects(input: EffectsExecuteRequest): Promise<EffectsExecuteResult> {
    this.calls.push('executeEffects');
    void input;
    return { ok: true, refs: {} };
  }
}

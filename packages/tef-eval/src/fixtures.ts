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

/** 与生产 Prisma 网关一致的开放订单状态口径。 */
const OPEN_ORDER_STATUSES: ReadonlySet<string> = new Set(['pending', 'confirmed', 'shipped']);
const OPEN_ORDER_LIMIT = 20;
const CUSTOMER_SEARCH_DEFAULT_LIMIT = 10;
const CUSTOMER_SEARCH_MAX_LIMIT = 50;

/** 递归冻结 fixture 数据，保证任何返回值都无法反向修改评测证据。 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value) as T;
}

/**
 * 评测用业务网关：只读冻结的业务证据，不访问数据库。
 * executeEffects 只记录调用，评测不执行真实副作用。
 */
export class FixtureCrmGateway implements CrmBusinessGateway {
  readonly calls: string[] = [];
  private readonly fixtures: Fixtures;

  constructor(fixtures: Fixtures) {
    this.fixtures = deepFreeze(fixtures);
  }

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
    const limit = Math.min(
      Math.max(input.limit ?? CUSTOMER_SEARCH_DEFAULT_LIMIT, 1),
      CUSTOMER_SEARCH_MAX_LIMIT,
    );
    return rows.slice(0, limit);
  }

  async getCustomer(input: { tenantId: string; customerId: string }): Promise<CustomerRecord | null> {
    this.calls.push('getCustomer');
    return this.fixtures.customers.find((customer) => customer.id === input.customerId) ?? null;
  }

  async getCredit(input: { tenantId: string; customerId: string }): Promise<CreditRecord | null> {
    this.calls.push('getCredit');
    // 直接查找客户，不经由 getCustomer：一次外部查询只记录一次调用。
    const customer =
      this.fixtures.customers.find((candidate) => candidate.id === input.customerId) ?? null;
    if (!customer) return null;
    // 与生产 Prisma 网关口径一致：只按客户与开放状态过滤，不按 balance 过滤；
    // createdAt 倒序取前 20 条。
    const openOrders = this.fixtures.orders
      .filter(
        (order) =>
          order.customerId === input.customerId && OPEN_ORDER_STATUSES.has(order.status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, OPEN_ORDER_LIMIT)
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
    // 端口级 tenantId 是唯一事实来源：params 中若带同名键，必须被端口值覆盖，
    // 与生产 Prisma 网关的 query 语义保持一致。
    const params: Record<string, unknown> & { tenantId: string } = {
      ...input.params,
      tenantId: input.tenantId,
    };
    switch (input.operation) {
      case CRM_QUERY.customerSearch:
        return (await this.searchCustomers({
          tenantId: params.tenantId,
          name: typeof params.name === 'string' ? params.name : undefined,
          phone: typeof params.phone === 'string' ? params.phone : undefined,
          limit: typeof params.limit === 'number' ? params.limit : undefined,
        })) as T;
      case CRM_QUERY.customerGet:
        return (await this.getCustomer({
          tenantId: params.tenantId,
          customerId: String(params.customerId ?? ''),
        })) as T;
      case CRM_QUERY.creditGet:
        return (await this.getCredit({
          tenantId: params.tenantId,
          customerId: String(params.customerId ?? ''),
        })) as T;
      case CRM_QUERY.productsGet:
        return (await this.getProducts({
          tenantId: params.tenantId,
          skus: Array.isArray(params.skus) ? (params.skus as string[]) : [],
        })) as T;
      case CRM_QUERY.productsSearch:
        return (await this.searchProducts({
          tenantId: params.tenantId,
          term: typeof params.term === 'string' ? params.term : undefined,
        })) as T;
      case CRM_QUERY.orderGet:
        return (await this.getOrder({
          tenantId: params.tenantId,
          orderId: typeof params.orderId === 'string' ? params.orderId : undefined,
          orderNo: typeof params.orderNo === 'string' ? params.orderNo : undefined,
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

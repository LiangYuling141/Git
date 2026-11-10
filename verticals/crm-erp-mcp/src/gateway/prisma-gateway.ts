import { TefError, type BusinessQueryRequest } from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';
import {
  CRM_QUERY,
  type CrmBusinessGateway,
  type CreditRecord,
  type CustomerRecord,
  type OrderRecord,
  type ProductRecord,
} from './types';

/**
 * CRM-ERP 的进程内业务网关实现。
 *
 * 框架核心只认识 `BusinessGateway` 端口的 `query` / `executeEffects`；这里把
 * 垂直查询翻译成 Prisma 查询，并通过 `CrmBusinessGateway` 暴露带类型的读方法。
 * 每个方法都显式校验调用方传入的 tenantId 与工厂闭包绑定的 tenantId 一致，
 * 拒绝时抛 PERMISSION_DENIED——这样进程内实现与后续 HTTP 实现的租户语义一致，
 * 不会出现"闭包租户静默兜底"导致跨租户读取的漏洞。
 */

function assertBoundTenant(boundTenantId: string, inputTenantId: string): void {
  if (inputTenantId !== boundTenantId) {
    throw new TefError('PERMISSION_DENIED', 'gateway tenant mismatch');
  }
}

function toCustomer(row: {
  id: string;
  name: string;
  phone: string;
  status: string;
  customerType: string;
  creditLimit: number;
  creditUsed: number;
  overdueDays: number;
  isHighRisk: boolean;
  monthlyTransaction: number;
  onboardingStatus: string;
}): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    customerType: row.customerType,
    creditLimit: row.creditLimit,
    creditUsed: row.creditUsed,
    overdueDays: row.overdueDays,
    isHighRisk: row.isHighRisk,
    monthlyTransaction: row.monthlyTransaction,
    onboardingStatus: row.onboardingStatus,
  };
}

function toProduct(row: {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  availableQty: number;
  reservedQty: number;
  unit: string;
}): ProductRecord {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unitPrice: row.unitPrice,
    availableQty: row.availableQty,
    reservedQty: row.reservedQty,
    unit: row.unit,
  };
}

export function createPrismaCrmGateway(tx: PrismaTx, tenantId: string): CrmBusinessGateway {
  const gateway: CrmBusinessGateway = {
    async searchCustomers(input) {
      assertBoundTenant(tenantId, input.tenantId);
      const { name, phone, limit } = input;
      // 防御纵深：工具层已校验，端口本身也不能允许"无任何业务标识"的查询，
      // 否则一次参数缺失会静默返回本租户全部客户。
      if (!name && !phone) {
        throw new TefError('VALIDATION_ERROR', 'customer search requires name or phone');
      }
      const rows = await tx.customer.findMany({
        where: {
          tenantId,
          OR: [
            ...(name ? [{ name: { contains: name } }] : []),
            ...(phone ? [{ phone: { contains: phone } }] : []),
          ],
        },
        take: Math.min(Math.max(limit ?? 10, 1), 50),
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map(toCustomer);
    },

    async getCustomer(input) {
      assertBoundTenant(tenantId, input.tenantId);
      // 防御纵深：query 端口以 `params as never` 透传，运行时可能缺少 customerId；
      // Prisma 会忽略 undefined 过滤条件并返回本租户任意客户，必须在触库前拒绝。
      if (typeof input.customerId !== 'string' || input.customerId.length === 0) {
        throw new TefError('VALIDATION_ERROR', 'customerId is required');
      }
      const row = await tx.customer.findFirst({ where: { id: input.customerId, tenantId } });
      return row ? toCustomer(row) : null;
    },

    async getCredit(input) {
      assertBoundTenant(tenantId, input.tenantId);
      if (typeof input.customerId !== 'string' || input.customerId.length === 0) {
        throw new TefError('VALIDATION_ERROR', 'customerId is required');
      }
      const [customer, openOrders] = await Promise.all([
        tx.customer.findFirst({ where: { id: input.customerId, tenantId } }),
        tx.order.findMany({
          where: { tenantId, customerId: input.customerId, status: { in: ['pending', 'confirmed', 'shipped'] } },
          select: { id: true, orderNo: true, balance: true, termsDays: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);
      if (!customer) return null;
      const result: CreditRecord = {
        customer: toCustomer(customer),
        openOrders: openOrders.map((order) => ({
          ...order,
          createdAt: order.createdAt.toISOString(),
        })),
      };
      return result;
    },

    async getProducts(input) {
      assertBoundTenant(tenantId, input.tenantId);
      // skus 缺失或不是数组时直接读 .length 会抛 TypeError 或静默查空，必须显式拒绝。
      if (!Array.isArray(input.skus)) {
        throw new TefError('VALIDATION_ERROR', 'skus must be an array');
      }
      if (input.skus.length === 0) return [];
      const rows = await tx.product.findMany({ where: { tenantId, sku: { in: input.skus } } });
      return rows.map(toProduct);
    },

    async searchProducts(input) {
      assertBoundTenant(tenantId, input.tenantId);
      const { term } = input;
      const rows = await tx.product.findMany({
        where: {
          tenantId,
          ...(term ? { OR: [{ sku: { contains: term } }, { name: { contains: term } }] } : {}),
        },
        orderBy: { sku: 'asc' },
        take: 50,
      });
      return rows.map(toProduct);
    },

    async getOrder(input) {
      assertBoundTenant(tenantId, input.tenantId);
      const { orderId, orderNo } = input;
      // 绝不允许仅凭 tenantId 取首条订单：没有业务标识就必须失败，
      // 否则一次参数缺失会静默返回"本租户最近一单"这种错误事实。
      if (!orderId && !orderNo) {
        throw new TefError('VALIDATION_ERROR', 'getOrder requires orderId or orderNo');
      }
      const row = await tx.order.findFirst({
        where: {
          tenantId,
          ...(orderId ? { id: orderId } : { orderNo: orderNo as string }),
        },
        include: { payments: true, customer: { select: { id: true, name: true } } },
      });
      if (!row) return null;
      const result: OrderRecord = {
        id: row.id,
        orderNo: row.orderNo,
        customerId: row.customerId,
        customerName: row.customer?.name ?? null,
        items: row.items,
        totalAmount: row.totalAmount,
        discount: row.discount,
        depositRate: row.depositRate,
        deposit: row.deposit,
        balance: row.balance,
        termsDays: row.termsDays,
        status: row.status,
        traceId: row.traceId,
        previewId: row.previewId,
        payments: row.payments.map((payment) => ({
          id: payment.id,
          amount: payment.amount,
          method: payment.method,
          status: payment.status,
          remark: payment.remark,
          dueAt: payment.dueAt?.toISOString() ?? null,
        })),
        createdAt: row.createdAt.toISOString(),
      };
      return result;
    },

    async query<T = unknown>(input: BusinessQueryRequest): Promise<T> {
      // 端口级 tenantId 是唯一事实来源：忽略 params 里的同名键，避免双份租户
      // 声明互相矛盾；每个 case 仍交给带类型的读方法做租户绑定校验。
      const params = { ...input.params, tenantId: input.tenantId } as never;
      switch (input.operation) {
        case CRM_QUERY.customerSearch:
          return gateway.searchCustomers(params) as Promise<T>;
        case CRM_QUERY.customerGet:
          return gateway.getCustomer(params) as Promise<T>;
        case CRM_QUERY.creditGet:
          return gateway.getCredit(params) as Promise<T>;
        case CRM_QUERY.productsGet:
          return gateway.getProducts(params) as Promise<T>;
        case CRM_QUERY.productsSearch:
          return gateway.searchProducts(params) as Promise<T>;
        case CRM_QUERY.orderGet:
          return gateway.getOrder(params) as Promise<T>;
        default:
          throw new TefError('VALIDATION_ERROR', `unknown business query: ${input.operation}`);
      }
    },

    async executeEffects(input) {
      assertBoundTenant(tenantId, input.tenantId);
      throw new TefError('INTERNAL', 'PrismaCrmGateway.executeEffects is implemented in Phase B2/C');
    },
  };
  return gateway;
}

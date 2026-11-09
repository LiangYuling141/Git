import type { BusinessGateway } from '@lymtrix/tef-core';

/** 业务系统返回的客户快照；字段是框架可理解的通用形状，不含 CRM 专属逻辑。 */
export interface CustomerRecord {
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
}

export interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  availableQty: number;
  reservedQty: number;
  unit: string;
}

export interface PaymentRecord {
  id: string;
  amount: number;
  method: string;
  status: string;
  remark?: string | null;
  dueAt?: string | null;
}

export interface OrderRecord {
  id: string;
  orderNo: string;
  customerId: string;
  customerName?: string | null;
  items: unknown;
  totalAmount: number;
  discount?: number | null;
  depositRate?: number | null;
  deposit?: number | null;
  balance: number;
  termsDays: number;
  status: string;
  traceId?: string | null;
  previewId?: string | null;
  payments: PaymentRecord[];
  createdAt: string;
}

export interface CreditRecord {
  customer: CustomerRecord;
  openOrders: Array<{
    id: string;
    orderNo: string;
    balance: number;
    termsDays: number;
    status: string;
    createdAt: string;
  }>;
}

export interface CustomerSearchInput {
  tenantId: string;
  name?: string;
  phone?: string;
  limit?: number;
}

/** 垂直查询白名单：核心只转交 operation 字符串，语义由这里定义。 */
export const CRM_QUERY = {
  customerSearch: 'crm.customer.search',
  customerGet: 'crm.customer.get',
  creditGet: 'crm.credit.get',
  productsGet: 'crm.products.get',
  productsSearch: 'crm.products.search',
  orderGet: 'crm.order.get',
} as const;

export type CrmQueryOperation = (typeof CRM_QUERY)[keyof typeof CRM_QUERY];

/**
 * CRM 垂直对核心端口的类型化扩展。
 *
 * 契约与查询工具依赖这些带类型的读方法；核心 `BusinessGateway` 只保留
 * `query` / `executeEffects`，因此核心不再认识任何 CRM DTO。
 */
export interface CrmBusinessGateway extends BusinessGateway {
  searchCustomers(input: CustomerSearchInput): Promise<CustomerRecord[]>;
  getCustomer(input: { tenantId: string; customerId: string }): Promise<CustomerRecord | null>;
  getCredit(input: { tenantId: string; customerId: string }): Promise<CreditRecord | null>;
  getProducts(input: { tenantId: string; skus: string[] }): Promise<ProductRecord[]>;
  searchProducts(input: { tenantId: string; term?: string }): Promise<ProductRecord[]>;
  getOrder(input: { tenantId: string; orderId?: string; orderNo?: string }): Promise<OrderRecord | null>;
}

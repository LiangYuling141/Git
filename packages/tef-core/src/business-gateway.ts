import type { Effect } from './types';

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

export interface EffectsExecuteRequest {
  tenantId: string;
  idempotencyKey: string;
  previewId: string;
  traceId: string;
  expectedEvidenceVersion?: string;
  effects: Effect[];
}

export interface EffectsExecuteResult {
  ok: boolean;
  refs: Record<string, Record<string, unknown>>;
  error?: { code: 'CONFLICT' | 'INTERNAL'; message: string };
}

/**
 * 业务数据访问端口。
 *
 * 框架核心只依赖这个接口；进程内由 Prisma 实现，跨服务时由 HTTP 实现。
 * 所有方法都必须显式带 tenantId，禁止跨租户读取。
 */
export interface BusinessGateway {
  searchCustomers(input: CustomerSearchInput): Promise<CustomerRecord[]>;
  getCustomer(input: { tenantId: string; customerId: string }): Promise<CustomerRecord | null>;
  getCredit(input: { tenantId: string; customerId: string }): Promise<CreditRecord | null>;
  getProducts(input: { tenantId: string; skus: string[] }): Promise<ProductRecord[]>;
  searchProducts(input: { tenantId: string; term?: string }): Promise<ProductRecord[]>;
  getOrder(input: { tenantId: string; orderId?: string; orderNo?: string }): Promise<OrderRecord | null>;
  executeEffects(input: EffectsExecuteRequest): Promise<EffectsExecuteResult>;
}

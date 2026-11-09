import { z } from 'zod';

/**
 * 义乌赊账订单契约的类型与 schema。
 *
 * 注意这里有两个 schema，职责不同：
 * - `createOrderRawSchema` 描述模型可以提交什么（也是 MCP 工具的 inputSchema 来源）；
 * - `createOrderParamsSchema` 描述 normalize() 之后、被 intentHash 绑定的那份参数。
 *
 * §5.1 的 `inputSchema: ZodSchema<P>` 指的是后者——引擎用它反向校验 normalize 的产物，
 * 防止契约自己算出一个不符合声明的参数。
 */

export const createOrderItemRawSchema = z.object({
  sku: z.string().min(1, 'sku is required'),
  quantity: z.number().int('quantity must be an integer').positive('quantity must be positive'),
  // 单价必须由调用方显式给出：它要进 intentHash，也就是人要批准的那份内容。
  // 模型如果不知道单价，应当先调查询工具，而不是猜。
  unitPrice: z.number().nonnegative('unitPrice must be >= 0'),
});

export const createOrderRawSchema = z.object({
  customerId: z.string().min(1, 'customerId is required'),
  items: z.array(createOrderItemRawSchema).min(1, 'at least one item is required'),
  discount: z.number().nonnegative().optional(),
  depositRate: z.number().min(0).max(1).optional(),
  termsDays: z.number().int().min(0).optional(),
  remark: z.string().max(500).optional(),
});

export interface CreateOrderItem {
  sku: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** normalize() 的输出，也就是 intentHash 绑定的内容。 */
export interface CreateOrderParams {
  customerId: string;
  items: CreateOrderItem[];
  discount: number;
  depositRate: number;
  termsDays: number;
  totalAmount: number;
  deposit: number;
  balance: number;
  remark?: string;
}

const paramsItemSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  subtotal: z.number().nonnegative(),
});

export const createOrderParamsSchema = z.object({
  customerId: z.string().min(1),
  items: z.array(paramsItemSchema).min(1),
  discount: z.number().nonnegative(),
  depositRate: z.number().min(0).max(1),
  termsDays: z.number().int().min(0),
  totalAmount: z.number().nonnegative(),
  deposit: z.number().nonnegative(),
  balance: z.number().nonnegative(),
  remark: z.string().max(500).optional(),
});

export type CreateOrderRawInput = z.infer<typeof createOrderRawSchema>;

/** 客户证据。字段名与 CRM 表对应，但契约只认这份结构，不直接依赖 Prisma 类型。 */
export interface CustomerEvidence {
  id: string;
  name: string;
  status: string;
  customerType: string;
  creditLimit: number;
  creditUsed: number;
  creditAvailable: number;
  overdueDays: number;
  isHighRisk: boolean;
}

export interface ProductEvidence {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  availableQty: number;
  reservedQty: number;
  unit: string;
}

export interface CreateOrderEvidence {
  /** 来自 ctx.timestampSnapshot，不是墙上时钟——纯函数与可复现的前提 */
  queriedAt: string;
  customer: CustomerEvidence | null;
  products: ProductEvidence[];
  /** 请求里提到但租户库存中不存在的 SKU */
  missingSkus: string[];
  overdueDaysThreshold: number;
}

export const OVERDUE_THRESHOLD_KEY = 'overdueDaysL2Threshold';
export const DEFAULT_OVERDUE_DAYS_L2_THRESHOLD = 30;

// -----------------------------------------------------------------------------
// compensate_order：已提交订单的补偿契约
// -----------------------------------------------------------------------------

export const compensateOrderRawSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  reason: z.string().max(500, 'reason must be at most 500 characters').optional(),
});

/** normalize() 的输出，也就是补偿令牌绑定的人批准内容。 */
export interface CompensateOrderParams {
  orderId: string;
  reason?: string;
}

export const compensateOrderParamsSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export interface OrderEvidence {
  id: string;
  orderNo: string;
  status: string;
  customerId: string;
  items: CreateOrderItem[];
  totalAmount: number;
  deposit: number;
  balance: number;
  previewId: string | null;
  traceId: string | null;
}

export type PaymentRole = 'deposit' | 'balance';

export interface PaymentEvidence {
  id: string;
  amount: number;
  method: string;
  status: string;
  remark: string | null;
  /** 由 loadEvidence 根据契约生成的 remark/method 推断，用于确定性重建补偿 refs。 */
  role: PaymentRole | null;
}

/**
 * 补偿证据。
 *
 * 同时包含「当前状态」（订单、收款、库存、额度）与「原始执行快照」：
 * 前置条件看当前状态，副作用复用原契约的 compensation 声明。
 */
export interface CompensateOrderEvidence {
  queriedAt: string;
  order: OrderEvidence | null;
  payments: PaymentEvidence[];
  products: ProductEvidence[];
  customer: CustomerEvidence | null;
  original: {
    params: CreateOrderParams;
    evidence: CreateOrderEvidence;
    contractOperation: string;
    contractVersion: string;
  } | null;
}

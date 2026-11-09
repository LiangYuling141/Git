import { TefError, formatCNY, toCents } from '@lymtrix/tef-core';
import type {
  AuditSpec,
  Check,
  Contract,
  DiffEntry,
  Effect,
  ExecContext,
  ExecResult,
  OrderRecord,
  RiskResult,
} from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';
import { CREATE_ORDER_OPERATION, createOrderContract } from './create-order';
import {
  compensateOrderParamsSchema,
  compensateOrderRawSchema,
  type CompensateOrderEvidence,
  type CompensateOrderParams,
  type CreateOrderEvidence,
  type CreateOrderItem,
  type CreateOrderParams,
  type CustomerEvidence,
  type OrderEvidence,
  type PaymentEvidence,
  type PaymentRole,
  type ProductEvidence,
} from './types';

/**
 * 已提交订单的补偿契约。
 *
 * 设计要点：
 * - 补偿本身也是一次写入，必须走 preview → 风险 → 令牌 → 人工确认 → execute；
 * - 补偿规则不在本文件重写，而是从订单的 previewId 找回原始快照，调用
 *   create_order 契约已声明的 compensation()。补偿声明只有一份。
 * - 只有经 TEF 创建、带 previewId 的订单可补偿；遗留 REST 订单会被阻断。
 */

export const COMPENSATE_ORDER_OPERATION = 'compensate_order';
export const COMPENSATE_ORDER_VERSION = '1.0';

/** §10.3 业务审计事件保留 3 年。 */
const RETAIN_DAYS = 1095;

function normalize(raw: unknown): CompensateOrderParams {
  const parsed = compensateOrderRawSchema.parse(raw);
  return parsed.reason === undefined
    ? { orderId: parsed.orderId }
    : { orderId: parsed.orderId, reason: parsed.reason };
}

function parseOrderItems(value: unknown): CreateOrderItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.sku !== 'string' || typeof row.quantity !== 'number' || typeof row.unitPrice !== 'number') {
      return [];
    }
    const subtotal =
      typeof row.subtotal === 'number' ? row.subtotal : row.quantity * row.unitPrice;
    return [{ sku: row.sku, quantity: row.quantity, unitPrice: row.unitPrice, subtotal }];
  });
}

/**
 * 收款计划角色由契约生成时的 remark/method 推断。
 * create_order 的 effects 固定用「定金」/「余款」前缀，因此这里是确定性的。
 */
function inferPaymentRole(remark: string | null, method: string): PaymentRole | null {
  const text = remark ?? '';
  if (text.startsWith('定金')) return 'deposit';
  if (text.startsWith('余款')) return 'balance';
  if (method === 'credit') return 'balance';
  if (method === 'transfer') return 'deposit';
  return null;
}

function toOrderEvidence(row: OrderRecord): OrderEvidence {
  return {
    id: row.id,
    orderNo: row.orderNo,
    status: row.status,
    customerId: row.customerId,
    items: parseOrderItems(row.items),
    totalAmount: row.totalAmount,
    deposit: row.deposit ?? 0,
    balance: row.balance,
    previewId: row.previewId ?? null,
    traceId: row.traceId ?? null,
  };
}

function toCustomerEvidence(row: {
  id: string;
  name: string;
  status: string;
  customerType: string;
  creditLimit: number;
  creditUsed: number;
  overdueDays: number;
  isHighRisk: boolean;
}): CustomerEvidence {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    customerType: row.customerType,
    creditLimit: row.creditLimit,
    creditUsed: row.creditUsed,
    creditAvailable: row.creditLimit - row.creditUsed,
    overdueDays: row.overdueDays,
    isHighRisk: row.isHighRisk,
  };
}

function toProductEvidence(row: {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  availableQty: number;
  reservedQty: number;
  unit: string;
}): ProductEvidence {
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

function requiredQtyBySku(items: CreateOrderItem[]): Map<string, number> {
  const required = new Map<string, number>();
  for (const item of items) {
    required.set(item.sku, (required.get(item.sku) ?? 0) + item.quantity);
  }
  return required;
}

function findPayment(evidence: CompensateOrderEvidence, role: PaymentRole): PaymentEvidence | undefined {
  return evidence.payments.find((payment) => payment.role === role);
}

async function loadEvidence(
  params: CompensateOrderParams,
  ctx: ExecContext<PrismaTx>,
): Promise<CompensateOrderEvidence> {
  const gateway = ctx.gateway;
  if (!gateway) throw new TefError('INTERNAL', 'BusinessGateway is not configured');

  const orderRow = await gateway.getOrder({ tenantId: ctx.tenantId, orderId: params.orderId });

  // 原始预览快照是 TEF 治理状态，不属于业务网关，仍从租户事务内读取。
  const originalSnapshot = orderRow?.previewId
    ? await ctx.db.previewSnapshot.findFirst({
        where: { id: orderRow.previewId, tenantId: ctx.tenantId },
      })
    : null;

  const skus = orderRow ? [...new Set(parseOrderItems(orderRow.items).map((item) => item.sku))] : [];

  const [customerRow, productRows] = await Promise.all([
    orderRow
      ? gateway.getCustomer({ tenantId: ctx.tenantId, customerId: orderRow.customerId })
      : Promise.resolve(null),
    skus.length > 0
      ? gateway.getProducts({ tenantId: ctx.tenantId, skus })
      : Promise.resolve([]),
  ]);

  const original =
    originalSnapshot && originalSnapshot.contract === CREATE_ORDER_OPERATION
      ? {
          params: originalSnapshot.normalizedArgs as unknown as CreateOrderParams,
          evidence: originalSnapshot.evidence as unknown as CreateOrderEvidence,
          contractOperation: originalSnapshot.contract,
          contractVersion: originalSnapshot.contractVersion,
        }
      : null;

  return {
    queriedAt: ctx.timestampSnapshot.toISOString(),
    order: orderRow ? toOrderEvidence(orderRow) : null,
    payments: (orderRow?.payments ?? []).map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      method: payment.method,
      status: payment.status,
      remark: payment.remark ?? null,
      role: inferPaymentRole(payment.remark ?? null, payment.method),
    })),
    products: productRows.map(toProductEvidence),
    customer: customerRow ? toCustomerEvidence(customerRow) : null,
    original,
  };
}

function preconditions(params: CompensateOrderParams, evidence: CompensateOrderEvidence): Check[] {
  const checks: Check[] = [
    {
      id: 'order.exists',
      ok: evidence.order !== null,
      code: 'ORDER_NOT_FOUND',
      message: `订单 ${params.orderId} 在本租户下不存在`,
    },
  ];

  if (!evidence.order) return checks;
  const order = evidence.order;

  checks.push({
    id: 'order.status_compensable',
    ok: order.status === 'confirmed',
    code: 'ORDER_NOT_COMPENSABLE',
    message: `订单状态为 ${order.status}，只有 confirmed 状态可补偿`,
  });

  checks.push({
    id: 'original.execution_found',
    ok: evidence.original !== null,
    code: 'ORIGINAL_EXECUTION_NOT_FOUND',
    message: '原始预览快照缺失，无法重放补偿声明；需要人工核对',
  });

  if (!evidence.original) return checks;
  const original = evidence.original;

  checks.push({
    id: 'order.matches_original',
    ok:
      toCents(order.totalAmount) === toCents(original.params.totalAmount) &&
      toCents(order.balance) === toCents(original.params.balance),
    code: 'ORDER_ORIGINAL_MISMATCH',
    message: `订单金额与原始批准参数不一致：当前总额 ${formatCNY(toCents(order.totalAmount))} / 余款 ${formatCNY(
      toCents(order.balance),
    )}，原始总额 ${formatCNY(toCents(original.params.totalAmount))} / 余款 ${formatCNY(toCents(original.params.balance))}`,
  });

  const deposit = findPayment(evidence, 'deposit');
  const balance = findPayment(evidence, 'balance');
  const planIssues: string[] = [];
  if (toCents(original.params.deposit) > 0 && !deposit) planIssues.push('缺少定金收款计划');
  if (toCents(original.params.balance) > 0 && !balance) planIssues.push('缺少余款收款计划');
  checks.push({
    id: 'payment.plan_consistent',
    ok: planIssues.length === 0,
    code: 'PAYMENT_PLAN_INCONSISTENT',
    message: planIssues.length > 0 ? planIssues.join('；') : '定金与余款收款计划完整',
  });

  const collected = evidence.payments.filter((payment) => payment.status !== 'pending');
  checks.push({
    id: 'payment.not_collected',
    ok: collected.length === 0,
    code: 'PAYMENT_ALREADY_COLLECTED',
    message:
      collected.length > 0
        ? `收款计划已进入 ${collected.map((payment) => payment.status).join(', ')}，需要退款流程，不能直接补偿`
        : '收款计划均未收款',
  });

  const required = requiredQtyBySku(original.params.items);
  const missingProducts = [...required.keys()].filter(
    (sku) => !evidence.products.some((product) => product.sku === sku),
  );
  checks.push({
    id: 'product.exists',
    ok: missingProducts.length === 0,
    code: 'PRODUCT_NOT_FOUND',
    message:
      missingProducts.length > 0
        ? `商品档案中不存在 SKU：${missingProducts.join(', ')}`
        : '商品档案完整',
  });

  const shortages: string[] = [];
  for (const [sku, quantity] of required) {
    const product = evidence.products.find((item) => item.sku === sku);
    if (product && product.reservedQty < quantity) {
      shortages.push(`${sku} 需要释放 ${quantity}${product.unit}，当前仅预占 ${product.reservedQty}${product.unit}`);
    }
  }
  checks.push({
    id: 'inventory.reserved_sufficient',
    ok: shortages.length === 0,
    code: 'RESERVED_INVENTORY_INSUFFICIENT',
    message: shortages.length > 0 ? shortages.join('；') : '预占库存充足',
  });

  const creditSufficient =
    evidence.customer !== null && toCents(evidence.customer.creditUsed) >= toCents(original.params.balance);
  checks.push({
    id: 'customer.credit_consistent',
    ok: creditSufficient,
    code: 'CREDIT_STATE_INCONSISTENT',
    message:
      evidence.customer === null
        ? '客户档案不存在，无法归还信用额度'
        : creditSufficient
          ? '信用占用与订单余款一致'
          : `当前已用额度 ${formatCNY(toCents(evidence.customer.creditUsed))} 少于订单余款 ${formatCNY(
              toCents(original.params.balance),
            )}，状态不一致`,
  });

  return checks;
}

function invariants(_params: CompensateOrderParams, evidence: CompensateOrderEvidence): Check[] {
  if (!evidence.order || !evidence.original) return [];
  const order = evidence.order;

  const expected = requiredQtyBySku(evidence.original.params.items);
  const actual = requiredQtyBySku(order.items);
  const itemsMatch =
    expected.size === actual.size &&
    [...expected.entries()].every(([sku, quantity]) => actual.get(sku) === quantity);

  const paymentTotal = evidence.payments.reduce((sum, payment) => sum + toCents(payment.amount), 0);

  return [
    {
      id: 'order.items_match_original',
      ok: itemsMatch,
      code: 'ORDER_ITEM_MISMATCH',
      message: itemsMatch ? '订单明细与原始参数一致' : '订单明细与原始批准参数不一致',
    },
    {
      id: 'payment.plan_matches_order',
      ok: paymentTotal === toCents(order.totalAmount),
      code: 'PAYMENT_PLAN_MISMATCH',
      message: `收款计划合计 ${formatCNY(paymentTotal)} 与订单总额 ${formatCNY(toCents(order.totalAmount))} 不一致`,
    },
  ];
}

function permissions(_params: CompensateOrderParams, ctx: ExecContext<PrismaTx>): Check[] {
  const allowed = ctx.role === 'owner' || ctx.role === 'sales';
  return [
    {
      id: 'role.can_compensate_order',
      ok: allowed,
      code: 'PERMISSION_DENIED',
      message: `角色 ${ctx.role} 无权发起补偿（需要 owner 或 sales）`,
    },
  ];
}

function riskRules(_params: CompensateOrderParams, evidence: CompensateOrderEvidence): RiskResult {
  const reasons = ['compensation_requires_human_approval'];
  if (evidence.order) reasons.push(`order_amount ${evidence.order.totalAmount}`);
  return { level: 'L2', reasons };
}

function buildRefs(evidence: CompensateOrderEvidence): ExecResult['refs'] {
  const refs: ExecResult['refs'] = {};
  if (evidence.order) refs.order = { id: evidence.order.id };
  const deposit = findPayment(evidence, 'deposit');
  if (deposit) refs.depositPayment = { id: deposit.id };
  const balance = findPayment(evidence, 'balance');
  if (balance) refs.balancePayment = { id: balance.id };
  return refs;
}

function effects(_params: CompensateOrderParams, evidence: CompensateOrderEvidence): Effect[] {
  if (!evidence.original) return [];
  // 补偿规则只有一份：复用 create_order 契约已声明的 compensation()。
  // 商品证据用当前行替换原始快照里的副本：SKU 相同，但主键必须是当前可写的那个。
  const compensationEvidence = { ...evidence.original.evidence, products: evidence.products };
  return createOrderContract.compensation(evidence.original.params, compensationEvidence, {
    ok: true,
    refs: buildRefs(evidence),
  });
}

function diff(_params: CompensateOrderParams, evidence: CompensateOrderEvidence): DiffEntry[] {
  const order = evidence.order;
  if (!order || !evidence.original) return [];

  const entries: DiffEntry[] = [
    {
      entity: 'order',
      action: 'update',
      label: `取消订单 ${order.orderNo}（总额 ${formatCNY(toCents(order.totalAmount))}）`,
      changes: [{ field: 'status', before: order.status, after: 'cancelled' }],
    },
  ];

  const deposit = findPayment(evidence, 'deposit');
  if (deposit) {
    entries.push({
      entity: 'payment',
      action: 'update',
      label: `作废定金收款计划 ${formatCNY(toCents(deposit.amount))}`,
      changes: [{ field: 'status', before: deposit.status, after: 'voided' }],
    });
  }

  const balance = findPayment(evidence, 'balance');
  if (balance) {
    entries.push({
      entity: 'payment',
      action: 'update',
      label: `作废余款收款计划 ${formatCNY(toCents(balance.amount))}`,
      changes: [{ field: 'status', before: balance.status, after: 'voided' }],
    });
  }

  for (const [sku, quantity] of requiredQtyBySku(evidence.original.params.items)) {
    const product = evidence.products.find((item) => item.sku === sku);
    if (!product) continue;
    entries.push({
      entity: 'product',
      action: 'release',
      label: `释放库存 ${product.name} ${quantity}${product.unit}`,
      changes: [
        { field: 'reservedQty', before: product.reservedQty, after: product.reservedQty - quantity },
        { field: 'availableQty', before: product.availableQty, after: product.availableQty + quantity },
      ],
    });
  }

  if (toCents(evidence.original.params.balance) > 0 && evidence.customer) {
    entries.push({
      entity: 'customer',
      action: 'update',
      label: `归还信用额度 ${formatCNY(toCents(evidence.original.params.balance))}`,
      changes: [
        {
          field: 'creditUsed',
          before: evidence.customer.creditUsed,
          after: evidence.customer.creditUsed - evidence.original.params.balance,
        },
        {
          field: 'creditAvailable',
          before: evidence.customer.creditAvailable,
          after: evidence.customer.creditAvailable + evidence.original.params.balance,
        },
      ],
    });
  }

  return entries;
}

function audit(
  _params: CompensateOrderParams,
  evidence: CompensateOrderEvidence,
  r: ExecResult | null,
): AuditSpec {
  const order = evidence.order;
  if (!order) {
    return { before: {}, after: {}, retainDays: RETAIN_DAYS };
  }

  const required = requiredQtyBySku(evidence.original?.params.items ?? []);
  const inventoryBefore: Record<string, number> = {};
  const inventoryAfter: Record<string, number> = {};
  for (const [sku, quantity] of required) {
    const product = evidence.products.find((item) => item.sku === sku);
    inventoryBefore[sku] = product?.reservedQty ?? 0;
    inventoryAfter[sku] = (product?.reservedQty ?? 0) - quantity;
  }

  return {
    // 假名：只存订单主键，不存客户名称或电话（§10.2）
    subjectRef: `order:${order.id}`,
    before: {
      orderStatus: order.status,
      paymentStatuses: Object.fromEntries(evidence.payments.map((payment) => [payment.id, payment.status])),
      inventory: inventoryBefore,
      creditUsed: evidence.customer?.creditUsed ?? 0,
    },
    after: r
      ? {
          orderStatus: 'cancelled',
          paymentStatuses: Object.fromEntries(evidence.payments.map((payment) => [payment.id, 'voided'])),
          inventory: inventoryAfter,
          creditUsed: (evidence.customer?.creditUsed ?? 0) - (evidence.original?.params.balance ?? 0),
        }
      : {},
    retainDays: RETAIN_DAYS,
  };
}

export const compensateOrderContract: Contract<CompensateOrderParams, CompensateOrderEvidence, PrismaTx> = {
  operation: COMPENSATE_ORDER_OPERATION,
  version: COMPENSATE_ORDER_VERSION,
  inputSchema: compensateOrderParamsSchema,
  normalize,
  loadEvidence,
  preconditions,
  invariants,
  permissions,
  riskRules,
  effects,
  compensation: () => [],
  audit,
  diff,
  auditResult: 'compensated',
};

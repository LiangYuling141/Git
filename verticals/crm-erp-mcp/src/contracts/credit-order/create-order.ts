import { z } from 'zod';
import { classifyRisk, formatCNY, fromCents, prorateCents, toCents } from '@lymtrix/tef-core';
import type { Check, Contract, DiffEntry, Effect, ExecContext, RiskResult } from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';
import { requireCrmGateway } from '../../gateway/context';
import {
  DEFAULT_OVERDUE_DAYS_L2_THRESHOLD,
  OVERDUE_THRESHOLD_KEY,
  createOrderParamsSchema,
  createOrderRawSchema,
  type CreateOrderEvidence,
  type CreateOrderParams,
  type ProductEvidence,
} from './types';

/**
 * 义乌赊账订单契约（docs/technical/14-unified-architecture.md §5、
 * docs/technical/13-trusted-execution-architecture.md §2.2）。
 *
 * 这里声明了这笔写入的全部规则：前置条件、不变量、权限、风险、副作用、补偿、审计。
 * 不存在第二套规则系统（公理 I5）——原来的 BusinessRule JSON、Hook、投票器都不参与判定。
 */

export const CREATE_ORDER_OPERATION = 'create_order';
export const CREATE_ORDER_VERSION = '1.0';

/** §10.3 业务审计事件保留 3 年。契约只能声明上限，不能覆盖合规下限。 */
const RETAIN_DAYS = 1095;

function findProduct(evidence: CreateOrderEvidence, sku: string): ProductEvidence | undefined {
  return evidence.products.find((product) => product.sku === sku);
}

function requiredQtyBySku(params: CreateOrderParams): Map<string, number> {
  const required = new Map<string, number>();
  for (const item of params.items) {
    required.set(item.sku, (required.get(item.sku) ?? 0) + item.quantity);
  }
  return required;
}

function normalize(raw: unknown): CreateOrderParams {
  const parsed = createOrderRawSchema.parse(raw);

  const items = parsed.items.map((item) => {
    const unitPriceCents = toCents(item.unitPrice);
    return {
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: fromCents(unitPriceCents),
      subtotal: fromCents(unitPriceCents * item.quantity),
    };
  });

  const discountCents = toCents(parsed.discount ?? 0);
  const grossCents = items.reduce((sum, item) => sum + toCents(item.unitPrice) * item.quantity, 0);
  const totalCents = grossCents - discountCents;
  if (totalCents < 0) {
    throw new Error(`discount ${formatCNY(discountCents)} exceeds line total ${formatCNY(grossCents)}`);
  }

  const depositRate = parsed.depositRate ?? 0;
  const depositCents = prorateCents(totalCents, depositRate);
  const balanceCents = totalCents - depositCents;

  return createOrderParamsSchema.parse({
    customerId: parsed.customerId,
    items,
    discount: fromCents(discountCents),
    depositRate,
    termsDays: parsed.termsDays ?? 0,
    totalAmount: fromCents(totalCents),
    deposit: fromCents(depositCents),
    balance: fromCents(balanceCents),
    remark: parsed.remark,
  }) as CreateOrderParams;
}

async function loadEvidence(params: CreateOrderParams, ctx: ExecContext<PrismaTx>): Promise<CreateOrderEvidence> {
  const gateway = requireCrmGateway(ctx);

  const skus = [...new Set(params.items.map((item) => item.sku))];

  // 每个查询都带 tenantId：跨租户的客户 ID 在这里直接查不到，
  // 后续会以 NOT_FOUND 阻断，而不是泄露"该 ID 在别的租户存在"。
  const [customerRow, productRows] = await Promise.all([
    gateway.getCustomer({ tenantId: ctx.tenantId, customerId: params.customerId }),
    gateway.getProducts({ tenantId: ctx.tenantId, skus }),
  ]);

  const overdueThreshold = ctx.tenantThresholds[OVERDUE_THRESHOLD_KEY];

  return {
    queriedAt: ctx.timestampSnapshot.toISOString(),
    customer: customerRow
      ? {
          id: customerRow.id,
          name: customerRow.name,
          status: customerRow.status,
          customerType: customerRow.customerType,
          creditLimit: customerRow.creditLimit,
          creditUsed: customerRow.creditUsed,
          creditAvailable: customerRow.creditLimit - customerRow.creditUsed,
          overdueDays: customerRow.overdueDays,
          isHighRisk: customerRow.isHighRisk,
        }
      : null,
    products: productRows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      unitPrice: row.unitPrice,
      availableQty: row.availableQty,
      reservedQty: row.reservedQty,
      unit: row.unit,
    })),
    missingSkus: skus.filter((sku) => !productRows.some((row) => row.sku === sku)),
    overdueDaysThreshold: Number.isFinite(overdueThreshold)
      ? (overdueThreshold as number)
      : DEFAULT_OVERDUE_DAYS_L2_THRESHOLD,
  };
}

function preconditions(params: CreateOrderParams, evidence: CreateOrderEvidence): Check[] {
  const checks: Check[] = [
    {
      id: 'customer.exists',
      ok: evidence.customer !== null,
      code: 'NOT_FOUND',
      message: `客户 ${params.customerId} 在本租户下不存在`,
    },
  ];

  if (!evidence.customer) return checks;
  const customer = evidence.customer;

  checks.push({
    id: 'customer.status_active',
    ok: customer.status === 'active',
    code: 'CUSTOMER_INACTIVE',
    message: `客户状态为 ${customer.status}，不可下单`,
  });

  checks.push({
    id: 'product.all_skus_known',
    ok: evidence.missingSkus.length === 0,
    code: 'UNKNOWN_SKU',
    message:
      evidence.missingSkus.length > 0 ? `本租户库存中不存在 SKU：${evidence.missingSkus.join(', ')}` : 'all skus known',
  });

  const shortages: string[] = [];
  for (const [sku, required] of requiredQtyBySku(params)) {
    const product = findProduct(evidence, sku);
    if (product && product.availableQty < required) {
      shortages.push(`${sku} 需要 ${required}${product.unit}，可用 ${product.availableQty}${product.unit}`);
    }
  }
  checks.push({
    id: 'inventory.available_sufficient',
    ok: shortages.length === 0,
    code: 'INSUFFICIENT_INVENTORY',
    message: shortages.length > 0 ? shortages.join('；') : '库存充足',
  });

  const priceMismatches: string[] = [];
  for (const item of params.items) {
    const product = findProduct(evidence, item.sku);
    if (product && toCents(product.unitPrice) !== toCents(item.unitPrice)) {
      priceMismatches.push(`${item.sku} 报价 ${formatCNY(toCents(item.unitPrice))}，档案价 ${formatCNY(toCents(product.unitPrice))}`);
    }
  }
  checks.push({
    id: 'product.price_matches_master',
    ok: priceMismatches.length === 0,
    code: 'PRICE_MISMATCH',
    message: priceMismatches.length > 0 ? priceMismatches.join('；') : '单价与商品档案一致',
  });

  // §2.2：customer.credit_available >= total_amount - deposit，即余款部分
  checks.push({
    id: 'customer.credit_available_sufficient',
    ok: customer.creditAvailable >= params.balance,
    code: 'INSUFFICIENT_CREDIT',
    message: `可用额度 ${formatCNY(toCents(customer.creditAvailable))}，本单余款需要 ${formatCNY(toCents(params.balance))}`,
  });

  return checks;
}

function invariants(params: CreateOrderParams): Check[] {
  const lineTotalCents = params.items.reduce((sum, item) => sum + toCents(item.unitPrice) * item.quantity, 0);
  const expectedTotalCents = lineTotalCents - toCents(params.discount);
  const expectedDepositCents = prorateCents(Math.max(expectedTotalCents, 0), params.depositRate);

  return [
    {
      id: 'total.equals_line_items',
      ok: toCents(params.totalAmount) === expectedTotalCents,
      code: 'TOTAL_MISMATCH',
      message: `总额 ${formatCNY(toCents(params.totalAmount))} 与明细合计 ${formatCNY(expectedTotalCents)} 不一致`,
    },
    {
      id: 'total.non_negative',
      ok: toCents(params.totalAmount) >= 0,
      code: 'NEGATIVE_TOTAL',
      message: `总额不可为负：${formatCNY(toCents(params.totalAmount))}`,
    },
    {
      id: 'deposit.matches_rate',
      ok: toCents(params.deposit) === expectedDepositCents,
      message: `定金 ${formatCNY(toCents(params.deposit))} 与 ${params.depositRate} × 总额不符`,
      code: 'DEPOSIT_MISMATCH',
    },
    {
      id: 'balance.equals_total_minus_deposit',
      ok: toCents(params.balance) === toCents(params.totalAmount) - toCents(params.deposit),
      code: 'BALANCE_MISMATCH',
      message: `余款 ${formatCNY(toCents(params.balance))} ≠ 总额 − 定金`,
    },
    {
      id: 'deposit_rate.in_range',
      ok: params.depositRate >= 0 && params.depositRate <= 1,
      code: 'INVALID_DEPOSIT_RATE',
      message: `定金比例必须在 0–1 之间，收到 ${params.depositRate}`,
    },
    {
      id: 'terms_days.non_negative',
      ok: params.termsDays >= 0,
      code: 'INVALID_TERMS_DAYS',
      message: `账期天数不可为负，收到 ${params.termsDays}`,
    },
  ];
}

function permissions(_params: CreateOrderParams, ctx: ExecContext<PrismaTx>): Check[] {
  // §11.2：owner 全部工具；sales 可写订单；finance 只管支付与额度，不改客户档案；viewer 只读。
  const allowed = ctx.role === 'owner' || ctx.role === 'sales';
  return [
    {
      id: 'role.can_create_order',
      ok: allowed,
      code: 'PERMISSION_DENIED',
      message: `角色 ${ctx.role} 无权创建订单（需要 owner 或 sales）`,
    },
  ];
}

function riskRules(params: CreateOrderParams, evidence: CreateOrderEvidence, ctx: ExecContext<PrismaTx>): RiskResult {
  const customer = evidence.customer;
  const base = classifyRisk({
    opType: 'create',
    entity: 'order',
    // 折扣属于 §3.2 第 4 步的敏感字段；按档案价成交的普通订单不算改价。
    fields: params.discount > 0 ? ['discount'] : [],
    amount: params.totalAmount,
    customer: {
      type: (customer?.customerType ?? 'normal') as 'normal' | 'new' | 'vip' | 'high_risk' | 'restricted',
      overdueDays: customer?.overdueDays ?? 0,
      creditAvailable: customer?.creditAvailable ?? 0,
    },
    context: {
      timestampSnapshot: ctx.timestampSnapshot,
      recentOpCount: ctx.recentOpCount,
      whitelistLevel: ctx.whitelistLevel,
      tenantThresholds: ctx.tenantThresholds,
    },
  });

  // Block 拥有最高优先级，不可被任何因子降级（§3）。
  if (base.level === 'Block') return base;

  const reasons = [...base.reasons];
  let escalated = base.level === 'L2';

  const overdueThreshold = evidence.overdueDaysThreshold;
  if (customer && customer.overdueDays > overdueThreshold) {
    reasons.push(`overdue_days ${customer.overdueDays} > ${overdueThreshold}`);
    escalated = true;
  }
  if (customer && customer.creditAvailable < params.totalAmount) {
    reasons.push(
      `credit_available ${formatCNY(toCents(customer.creditAvailable))} < total_amount ${formatCNY(toCents(params.totalAmount))}`,
    );
    escalated = true;
  }

  return { level: escalated ? 'L2' : base.level, reasons };
}

function effects(params: CreateOrderParams, evidence: CreateOrderEvidence): Effect[] {
  const out: Effect[] = [
    {
      type: 'create',
      entity: 'order',
      as: 'order',
      payload: {
        customerId: params.customerId,
        items: params.items,
        totalAmount: params.totalAmount,
        discount: params.discount,
        depositRate: params.depositRate,
        deposit: params.deposit,
        balance: params.balance,
        termsDays: params.termsDays,
        remark: params.remark ?? null,
        status: 'confirmed',
      },
    },
  ];

  if (params.deposit > 0) {
    out.push({
      type: 'create',
      entity: 'payment',
      as: 'depositPayment',
      payload: {
        amount: params.deposit,
        method: 'transfer',
        status: 'pending',
        remark: `定金 ${params.depositRate * 100}%`,
        dueInDays: 0,
      },
      bind: { orderId: { fromRef: 'order', field: 'id' } },
    });
  }

  if (params.balance > 0) {
    out.push({
      type: 'create',
      entity: 'payment',
      as: 'balancePayment',
      payload: {
        amount: params.balance,
        method: 'credit',
        status: 'pending',
        remark: `余款，${params.termsDays} 天账期`,
        dueInDays: params.termsDays,
      },
      bind: { orderId: { fromRef: 'order', field: 'id' } },
    });
  }

  for (const [sku, quantity] of requiredQtyBySku(params)) {
    const product = findProduct(evidence, sku);
    // 缺 SKU 的情况已被 inventory 前置条件阻断，这里不需要再处理。
    if (!product) continue;
    out.push({
      type: 'reserve',
      entity: 'product',
      target: product.id,
      payload: {},
      increment: { reservedQty: quantity, availableQty: -quantity },
    });
  }

  if (params.balance > 0) {
    out.push({
      type: 'update',
      entity: 'customer',
      target: params.customerId,
      payload: { touchLastTransactionDate: true },
      increment: { creditUsed: params.balance },
    });
  }

  return out;
}

function compensation(params: CreateOrderParams, evidence: CreateOrderEvidence, r: { refs: Record<string, Record<string, unknown>> }) {
  const out: Effect[] = [];

  const orderId = r.refs.order?.id as string | undefined;
  if (orderId) {
    // `as: 'order'` 让通用执行器把补偿后的订单引用带回响应，便于确认页与审计定位。
    out.push({ type: 'update', entity: 'order', as: 'order', target: orderId, payload: { status: 'cancelled' } });
  }

  for (const ref of ['depositPayment', 'balancePayment']) {
    const paymentId = r.refs[ref]?.id as string | undefined;
    if (paymentId) {
      out.push({ type: 'update', entity: 'payment', target: paymentId, payload: { status: 'voided' } });
    }
  }

  for (const [sku, quantity] of requiredQtyBySku(params)) {
    const product = findProduct(evidence, sku);
    if (!product) continue;
    out.push({
      type: 'release',
      entity: 'product',
      target: product.id,
      payload: {},
      increment: { reservedQty: -quantity, availableQty: quantity },
    });
  }

  if (params.balance > 0) {
    out.push({
      type: 'update',
      entity: 'customer',
      target: params.customerId,
      payload: {},
      increment: { creditUsed: -params.balance },
    });
  }

  return out;
}

function inventorySnapshot(evidence: CreateOrderEvidence, params: CreateOrderParams, after: boolean): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const [sku, quantity] of requiredQtyBySku(params)) {
    const product = findProduct(evidence, sku);
    if (!product) continue;
    snapshot[sku] = after ? product.availableQty - quantity : product.availableQty;
  }
  return snapshot;
}

function audit(params: CreateOrderParams, evidence: CreateOrderEvidence, r: { ok: boolean } | null) {
  const customer = evidence.customer;
  const creditAvailableBefore = customer?.creditAvailable ?? 0;
  return {
    // 假名：只存代理键，不存客户名称（§10.2）
    subjectRef: customer ? `cust:${customer.id}` : undefined,
    before: {
      creditAvailable: creditAvailableBefore,
      creditUsed: customer?.creditUsed ?? 0,
      inventory: inventorySnapshot(evidence, params, false),
    },
    after: r
      ? {
          creditAvailable: creditAvailableBefore - params.balance,
          creditUsed: (customer?.creditUsed ?? 0) + params.balance,
          inventory: inventorySnapshot(evidence, params, true),
        }
      : {},
    retainDays: RETAIN_DAYS,
  };
}

function diff(params: CreateOrderParams, evidence: CreateOrderEvidence): DiffEntry[] {
  const customer = evidence.customer;
  const entries: DiffEntry[] = [
    {
      entity: 'order',
      action: 'create',
      label: `为「${customer?.name ?? params.customerId}」创建赊账订单 ${formatCNY(toCents(params.totalAmount))}`,
      payload: {
        customer: customer?.name ?? params.customerId,
        items: params.items.map((item) => {
          const product = findProduct(evidence, item.sku);
          return `${product?.name ?? item.sku} × ${item.quantity}${product?.unit ?? ''} @ ${formatCNY(toCents(item.unitPrice))}`;
        }),
        totalAmount: params.totalAmount,
        deposit: params.deposit,
        balance: params.balance,
        termsDays: params.termsDays,
      },
      changes: [
        { field: 'totalAmount', before: undefined, after: params.totalAmount },
        { field: 'deposit', before: undefined, after: params.deposit },
        { field: 'balance', before: undefined, after: params.balance },
        { field: 'termsDays', before: undefined, after: params.termsDays },
      ],
    },
  ];

  for (const [sku, quantity] of requiredQtyBySku(params)) {
    const product = findProduct(evidence, sku);
    if (!product) continue;
    entries.push({
      entity: 'product',
      action: 'reserve',
      label: `预占 ${product.name} ${quantity}${product.unit}`,
      changes: [{ field: 'availableQty', before: product.availableQty, after: product.availableQty - quantity }],
    });
  }

  if (params.balance > 0 && customer) {
    entries.push({
      entity: 'customer',
      action: 'update',
      label: `占用信用额度 ${formatCNY(toCents(params.balance))}`,
      changes: [
        { field: 'creditUsed', before: customer.creditUsed, after: customer.creditUsed + params.balance },
        { field: 'creditAvailable', before: customer.creditAvailable, after: customer.creditAvailable - params.balance },
      ],
    });
  }

  return entries;
}

export const createOrderContract: Contract<CreateOrderParams, CreateOrderEvidence, PrismaTx> = {
  operation: CREATE_ORDER_OPERATION,
  version: CREATE_ORDER_VERSION,
  inputSchema: createOrderParamsSchema as unknown as z.ZodType<CreateOrderParams>,
  normalize,
  loadEvidence,
  preconditions,
  invariants,
  permissions,
  riskRules,
  effects,
  compensation,
  audit,
  diff,
};

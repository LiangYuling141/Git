import { auditChain } from '@/tef/audit-chain';
import { redactArgs } from '@/tef/redaction';
import { withTenantScope } from '@/tef/tenant-scope';
import type { Envelope, PrismaTx } from '@/tef/types';
import { fail, ok } from '../envelope';
import { buildExecContext, type Principal } from '../principal';

/**
 * 查询工具（L0，只读）。
 *
 * 每个查询都带 tenantId 条件：RLS 是第一道防线，这里是第二道（§11.1）。
 * 返回里带 `asOf`，让上下文装配能标注"这条事实是什么时候查到的"（§8.3）——
 * 聊天历史不是事实源。
 */

export interface QueryOptions {
  traceId: string;
  now?: Date;
}

/** 电话属于直接标识。工具响应会进模型上下文，所以默认打码。 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (phone.length < 7) return '*'.repeat(phone.length);
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

async function auditQuery(
  principal: Principal,
  tx: PrismaTx,
  options: QueryOptions & { tool: string; args: Record<string, unknown>; subjectRef?: string },
  now: Date,
): Promise<string> {
  const appended = await auditChain.append(
    {
      traceId: options.traceId,
      tenantId: principal.tenantId,
      actorId: principal.userId,
      actorType: principal.clientKind === 'agent' ? 'agent' : 'human',
      tool: options.tool,
      contract: '',
      contractVersion: '',
      intentHash: '',
      argsRedacted: redactArgs(options.args),
      evidenceDigest: '',
      risk: 'L0',
      reasons: ['read_only_query'],
      decision: 'allow',
      result: 'success',
      subjectRef: options.subjectRef ?? null,
    },
    tx,
    now,
  );
  return appended.eventId;
}

export async function customerSearch(
  principal: Principal,
  args: { name?: string; phone?: string; limit?: number },
  options: QueryOptions,
): Promise<Envelope> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const phone = typeof args.phone === 'string' ? args.phone.trim() : '';
  if (!name && !phone) {
    return fail('VALIDATION_ERROR', 'customer.search requires at least one of name or phone');
  }
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const now = options.now ?? new Date();

  return withTenantScope(principal.tenantId, async (tx) => {
    const rows = await tx.customer.findMany({
      where: {
        tenantId: principal.tenantId,
        OR: [
          ...(name ? [{ name: { contains: name } }] : []),
          ...(phone ? [{ phone: { contains: phone } }] : []),
        ],
      },
      take: limit,
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });

    // matchReason 让澄清界面能解释"为什么这几个是候选"（§7.3）
    const candidates = rows.map((row) => ({
      id: row.id,
      label: row.name,
      phone: maskPhone(row.phone),
      matchReason: phone && row.phone === phone ? 'phone_exact' : name && row.name === name ? 'name_exact' : 'name_contains',
      creditAvailable: row.creditLimit - row.creditUsed,
      status: row.status,
    }));

    const auditId = await auditQuery(principal, tx, { ...options, tool: 'customer.search', args }, now);

    return ok(
      { candidates, count: candidates.length, asOf: now.toISOString() },
      {
        risk: 'L0',
        reasons: ['read_only_query'],
        auditId,
        traceId: options.traceId,
        evidence: { candidates, queriedAt: now.toISOString() },
      },
    );
  });
}

export async function customerGet(
  principal: Principal,
  args: { customerId: string },
  options: QueryOptions,
): Promise<Envelope> {
  if (!args.customerId) return fail('VALIDATION_ERROR', 'customerId is required');
  const now = options.now ?? new Date();

  return withTenantScope(principal.tenantId, async (tx) => {
    const row = await tx.customer.findFirst({ where: { id: args.customerId, tenantId: principal.tenantId } });
    if (!row) {
      // 不区分"不存在"与"属于别的租户"：否则会变成一个跨租户 ID 探测器。
      return fail('NOT_FOUND', `customer ${args.customerId} not found`);
    }

    const snapshot = {
      id: row.id,
      name: row.name,
      phone: maskPhone(row.phone),
      customerType: row.customerType,
      status: row.status,
      isHighRisk: row.isHighRisk,
      creditLimit: row.creditLimit,
      creditUsed: row.creditUsed,
      creditAvailable: row.creditLimit - row.creditUsed,
      overdueDays: row.overdueDays,
      monthlyTransaction: row.monthlyTransaction,
      onboardingStatus: row.onboardingStatus,
      asOf: now.toISOString(),
    };

    const auditId = await auditQuery(
      principal,
      tx,
      { ...options, tool: 'customer.get', args, subjectRef: `cust:${row.id}` },
      now,
    );

    return ok(snapshot, {
      risk: 'L0',
      reasons: ['read_only_query'],
      auditId,
      traceId: options.traceId,
      evidence: snapshot,
    });
  });
}

export async function creditGet(
  principal: Principal,
  args: { customerId: string },
  options: QueryOptions,
): Promise<Envelope> {
  if (!args.customerId) return fail('VALIDATION_ERROR', 'customerId is required');
  const now = options.now ?? new Date();

  return withTenantScope(principal.tenantId, async (tx) => {
    const [customer, openOrders] = await Promise.all([
      tx.customer.findFirst({ where: { id: args.customerId, tenantId: principal.tenantId } }),
      tx.order.findMany({
        where: {
          tenantId: principal.tenantId,
          customerId: args.customerId,
          status: { in: ['pending', 'confirmed', 'shipped'] },
        },
        select: { id: true, orderNo: true, balance: true, termsDays: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    if (!customer) return fail('NOT_FOUND', `customer ${args.customerId} not found`);

    const creditAvailable = customer.creditLimit - customer.creditUsed;
    const data = {
      customerId: customer.id,
      creditLimit: customer.creditLimit,
      creditUsed: customer.creditUsed,
      creditAvailable,
      overdueDays: customer.overdueDays,
      isHighRisk: customer.isHighRisk,
      customerType: customer.customerType,
      openOrders: openOrders.map((order) => ({
        orderNo: order.orderNo,
        balance: order.balance,
        termsDays: order.termsDays,
        status: order.status,
      })),
      openBalanceTotal: openOrders.reduce((sum, order) => sum + order.balance, 0),
      asOf: now.toISOString(),
    };

    const auditId = await auditQuery(
      principal,
      tx,
      { ...options, tool: 'credit.get', args, subjectRef: `cust:${customer.id}` },
      now,
    );

    return ok(data, {
      risk: 'L0',
      reasons: ['read_only_query'],
      auditId,
      traceId: options.traceId,
      evidence: data,
    });
  });
}

export async function inventoryCheck(
  principal: Principal,
  args: { sku?: string; quantity?: number },
  options: QueryOptions,
): Promise<Envelope> {
  const now = options.now ?? new Date();

  return withTenantScope(principal.tenantId, async (tx) => {
    // 口语里说的是商品名（"圣诞球"），档案里的主键是 SKU（XMAS-BALL-01），
    // 所以两者都要能匹配——否则模型只能靠猜 SKU。
    const term = typeof args.sku === 'string' && args.sku.trim() ? args.sku.trim() : undefined;
    const rows = await tx.product.findMany({
      where: {
        tenantId: principal.tenantId,
        ...(term ? { OR: [{ sku: { contains: term } }, { name: { contains: term } }] } : {}),
      },
      orderBy: { sku: 'asc' },
      take: 50,
    });

    const requested = typeof args.quantity === 'number' ? args.quantity : undefined;
    const items = rows.map((row) => ({
      sku: row.sku,
      productId: row.id,
      name: row.name,
      unit: row.unit,
      unitPrice: row.unitPrice,
      availableQty: row.availableQty,
      reservedQty: row.reservedQty,
      // 报价必须来自档案：模型自己编的单价会在契约的 price_matches_master 处被拦下
      sufficient: requested === undefined ? undefined : row.availableQty >= requested,
    }));

    const auditId = await auditQuery(principal, tx, { ...options, tool: 'inventory.check', args }, now);

    return ok(
      { items, count: items.length, asOf: now.toISOString() },
      { risk: 'L0', reasons: ['read_only_query'], auditId, traceId: options.traceId, evidence: { items } },
    );
  });
}

export async function orderGet(
  principal: Principal,
  args: { orderId?: string; orderNo?: string },
  options: QueryOptions,
): Promise<Envelope> {
  if (!args.orderId && !args.orderNo) {
    return fail('VALIDATION_ERROR', 'order.get requires orderId or orderNo');
  }
  const now = options.now ?? new Date();

  return withTenantScope(principal.tenantId, async (tx) => {
    const row = await tx.order.findFirst({
      where: {
        tenantId: principal.tenantId,
        ...(args.orderId ? { id: args.orderId } : { orderNo: args.orderNo as string }),
      },
      include: { payments: true, customer: { select: { id: true, name: true } } },
    });
    if (!row) return fail('NOT_FOUND', 'order not found');

    const data = {
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
        dueAt: payment.dueAt?.toISOString() ?? null,
      })),
      asOf: now.toISOString(),
    };

    const auditId = await auditQuery(
      principal,
      tx,
      { ...options, tool: 'order.get', args, subjectRef: `order:${row.id}` },
      now,
    );

    return ok(data, {
      risk: 'L0',
      reasons: ['read_only_query'],
      auditId,
      traceId: options.traceId,
      evidence: data,
    });
  });
}

export { buildExecContext };

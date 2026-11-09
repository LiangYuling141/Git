import { describe, expect, it, vi } from 'vitest';
import { TefError, type BusinessGateway } from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';
import { createPrismaCrmGateway } from './prisma-gateway';

const BOUND_TENANT = 't_yiwu_demo';
const OTHER_TENANT = 't_other';

/**
 * 任何属性访问都会抛错的事务替身：用来证明租户校验发生在触库之前。
 * 若实现先读了 tx.customer / tx.order，这里会抛出与 PERMISSION_DENIED 不同的错误。
 */
function untouchableTx(): { tx: PrismaTx; touched: string[] } {
  const touched: string[] = [];
  const tx = new Proxy({} as PrismaTx, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`tx.${String(property)} must not be touched`);
    },
  });
  return { tx, touched };
}

async function expectPermissionDenied(call: () => Promise<unknown>): Promise<void> {
  const error = await call().then(
    () => {
      throw new Error('expected the gateway to reject, but it resolved');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TefError);
  expect((error as TefError).code).toBe('PERMISSION_DENIED');
  expect((error as TefError).message).toBe('gateway tenant mismatch');
}

describe('租户绑定：调用方 tenantId 必须与工厂闭包一致', () => {
  it('7 个方法在 tenantId 不匹配时全部抛 PERMISSION_DENIED，且不触碰事务', async () => {
    const { tx, touched } = untouchableTx();
    const gateway = createPrismaCrmGateway(tx, BOUND_TENANT);

    const calls: Array<[keyof BusinessGateway, () => Promise<unknown>]> = [
      ['searchCustomers', () => gateway.searchCustomers({ tenantId: OTHER_TENANT })],
      ['getCustomer', () => gateway.getCustomer({ tenantId: OTHER_TENANT, customerId: 'c_1' })],
      ['getCredit', () => gateway.getCredit({ tenantId: OTHER_TENANT, customerId: 'c_1' })],
      ['getProducts', () => gateway.getProducts({ tenantId: OTHER_TENANT, skus: ['SKU-1'] })],
      ['searchProducts', () => gateway.searchProducts({ tenantId: OTHER_TENANT, term: '圣诞' })],
      ['getOrder', () => gateway.getOrder({ tenantId: OTHER_TENANT, orderId: 'ord_1' })],
      [
        'executeEffects',
        () =>
          gateway.executeEffects({
            tenantId: OTHER_TENANT,
            idempotencyKey: 'idem_1',
            previewId: 'prev_1',
            traceId: 'tr_1',
            effects: [],
          }),
      ],
    ];

    for (const [method, call] of calls) {
      await expectPermissionDenied(call);
      expect(touched, `${method} must reject before touching the transaction`).toEqual([]);
    }
  });
});

describe('响应映射：保留契约依赖的关键字段', () => {
  it('getCustomer 保留额度字段，getOrder 保留收款计划、dueAt 与 previewId', async () => {
    const customerRow = {
      id: 'c_weiye_import',
      name: '义乌市伟业进出口有限公司',
      phone: '13905791001',
      status: 'active',
      customerType: 'normal',
      creditLimit: 50000,
      creditUsed: 40000,
      overdueDays: 0,
      isHighRisk: false,
      monthlyTransaction: 120000,
      onboardingStatus: 'approved',
    };
    const dueAt = new Date('2026-12-09T00:00:00.000Z');
    const orderRow = {
      id: 'ord_1',
      orderNo: 'SO-1',
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 5000, unitPrice: 2, subtotal: 10000 }],
      totalAmount: 10000,
      discount: 0,
      depositRate: 0.3,
      deposit: 3000,
      balance: 7000,
      termsDays: 30,
      status: 'confirmed',
      traceId: 'tr_1',
      previewId: 'prev_1',
      payments: [
        { id: 'pay_deposit', amount: 3000, method: 'transfer', status: 'pending', remark: '定金', dueAt },
        { id: 'pay_balance', amount: 7000, method: 'credit', status: 'pending', remark: null, dueAt: null },
      ],
      customer: { id: 'c_weiye_import', name: '义乌市伟业进出口有限公司' },
      createdAt: new Date('2026-11-09T00:00:00.000Z'),
    };

    const findCustomer = vi.fn(async () => customerRow);
    const findOrder = vi.fn(async () => orderRow);
    const tx = {
      customer: { findFirst: findCustomer },
      order: { findFirst: findOrder },
    } as unknown as PrismaTx;
    const gateway = createPrismaCrmGateway(tx, BOUND_TENANT);

    const customer = await gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_weiye_import' });
    expect(customer).toMatchObject({
      id: 'c_weiye_import',
      creditLimit: 50000,
      creditUsed: 40000,
      overdueDays: 0,
      isHighRisk: false,
      onboardingStatus: 'approved',
    });
    expect(findCustomer).toHaveBeenCalledWith({
      where: { id: 'c_weiye_import', tenantId: BOUND_TENANT },
    });

    const order = await gateway.getOrder({ tenantId: BOUND_TENANT, orderId: 'ord_1' });
    expect(findOrder).toHaveBeenCalledWith({
      where: { tenantId: BOUND_TENANT, id: 'ord_1' },
      include: { payments: true, customer: { select: { id: true, name: true } } },
    });
    expect(order).toMatchObject({
      id: 'ord_1',
      orderNo: 'SO-1',
      previewId: 'prev_1',
      customerName: '义乌市伟业进出口有限公司',
      totalAmount: 10000,
      deposit: 3000,
      balance: 7000,
      termsDays: 30,
      status: 'confirmed',
      createdAt: '2026-11-09T00:00:00.000Z',
    });
    expect(order?.payments).toEqual([
      {
        id: 'pay_deposit',
        amount: 3000,
        method: 'transfer',
        status: 'pending',
        remark: '定金',
        dueAt: '2026-12-09T00:00:00.000Z',
      },
      {
        id: 'pay_balance',
        amount: 7000,
        method: 'credit',
        status: 'pending',
        remark: null,
        dueAt: null,
      },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { CRM_QUERY } from '@lymtrix/vertical-crm-erp';
import { FixtureCrmGateway } from './fixtures';

const CUSTOMER_NAME = '义乌市伟业进出口有限公司';

const fixtures = {
  customers: [
    {
      id: 'c_weiye',
      name: CUSTOMER_NAME,
      phone: '13800000001',
      status: 'active',
      customerType: 'normal',
      creditLimit: 50000,
      creditUsed: 0,
      overdueDays: 0,
      isHighRisk: false,
      monthlyTransaction: 0,
      onboardingStatus: 'completed',
    },
  ],
  products: [
    {
      id: 'p_ball',
      sku: 'XMAS-BALL-01',
      name: '圣诞球',
      unitPrice: 2,
      availableQty: 20000,
      reservedQty: 0,
      unit: '个',
    },
  ],
  orders: [
    {
      id: 'o_1',
      orderNo: 'SO-2026-0001',
      customerId: 'c_weiye',
      customerName: CUSTOMER_NAME,
      items: [{ sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2 }],
      totalAmount: 200,
      balance: 200,
      termsDays: 30,
      status: 'confirmed',
      payments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

function makeGateway(overrides: Partial<typeof fixtures> = {}): FixtureCrmGateway {
  return new FixtureCrmGateway({ ...fixtures, ...overrides });
}

describe('FixtureCrmGateway', () => {
  it('searches customers by name and phone', async () => {
    const gateway = makeGateway();
    expect(await gateway.searchCustomers({ tenantId: 't', name: '伟业' })).toHaveLength(1);
    expect(await gateway.searchCustomers({ tenantId: 't', phone: '13800000001' })).toHaveLength(1);
    expect(await gateway.searchCustomers({ tenantId: 't', name: '不存在' })).toHaveLength(0);
  });

  it('clamps the customer search limit to 1..50', async () => {
    const manyCustomers = Array.from({ length: 60 }, (_, index) => ({
      ...fixtures.customers[0],
      id: `c_${index}`,
      name: `客户${index}`,
      phone: `1380000${String(index).padStart(4, '0')}`,
    }));
    const gateway = makeGateway({ customers: manyCustomers });

    expect(await gateway.searchCustomers({ tenantId: 't', name: '客户', limit: 0 })).toHaveLength(1);
    expect(await gateway.searchCustomers({ tenantId: 't', name: '客户', limit: -5 })).toHaveLength(1);
    expect(await gateway.searchCustomers({ tenantId: 't', name: '客户', limit: 1000 })).toHaveLength(50);
  });

  it('returns customer, credit, products and orders', async () => {
    const gateway = makeGateway();
    expect((await gateway.getCustomer({ tenantId: 't', customerId: 'c_weiye' }))?.id).toBe('c_weiye');
    expect((await gateway.getCredit({ tenantId: 't', customerId: 'c_weiye' }))?.openOrders).toHaveLength(1);
    expect(await gateway.getProducts({ tenantId: 't', skus: ['XMAS-BALL-01'] })).toHaveLength(1);
    expect(await gateway.searchProducts({ tenantId: 't', term: '圣诞' })).toHaveLength(1);
    expect((await gateway.getOrder({ tenantId: 't', orderNo: 'SO-2026-0001' }))?.id).toBe('o_1');
  });

  it('getCredit follows the production open-order status set and ordering', async () => {
    const base = fixtures.orders[0];
    const gateway = makeGateway({
      orders: [
        {
          ...base,
          id: 'o_completed',
          orderNo: 'SO-COMPLETED',
          status: 'completed',
          balance: 100,
          createdAt: '2026-01-04T00:00:00.000Z',
        },
        {
          ...base,
          id: 'o_cancelled',
          orderNo: 'SO-CANCELLED',
          status: 'cancelled',
          balance: 100,
          createdAt: '2026-01-05T00:00:00.000Z',
        },
        {
          ...base,
          id: 'o_confirmed',
          orderNo: 'SO-CONFIRMED',
          status: 'confirmed',
          balance: 0,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          ...base,
          id: 'o_pending',
          orderNo: 'SO-PENDING',
          status: 'pending',
          balance: 50,
          createdAt: '2026-01-03T00:00:00.000Z',
        },
        {
          ...base,
          id: 'o_shipped',
          orderNo: 'SO-SHIPPED',
          status: 'shipped',
          balance: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const credit = await gateway.getCredit({ tenantId: 't', customerId: 'c_weiye' });

    // completed/cancelled 即使有余额也排除；confirmed 即使余额为 0 也保留（不按 balance 过滤）；
    // 结果按 createdAt 倒序。
    expect(credit?.openOrders.map((order) => order.id)).toEqual([
      'o_pending',
      'o_confirmed',
      'o_shipped',
    ]);
  });

  it('getCredit caps open orders at 20, newest first', async () => {
    const base = fixtures.orders[0];
    const orders = Array.from({ length: 25 }, (_, index) => ({
      ...base,
      id: `o_${index}`,
      orderNo: `SO-2026-${String(index).padStart(4, '0')}`,
      status: 'pending',
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));
    const gateway = makeGateway({ orders });

    const credit = await gateway.getCredit({ tenantId: 't', customerId: 'c_weiye' });

    expect(credit?.openOrders).toHaveLength(20);
    expect(credit?.openOrders[0]?.id).toBe('o_24');
    expect(credit?.openOrders[19]?.id).toBe('o_5');
  });

  it('records exactly one getCredit call without dispatching getCustomer', async () => {
    const gateway = makeGateway();
    await gateway.getCredit({ tenantId: 't', customerId: 'c_weiye' });
    expect(gateway.calls).toEqual(['getCredit']);
  });

  it('deep-freezes fixture records returned to callers', async () => {
    const gateway = makeGateway();
    const customer = await gateway.getCustomer({ tenantId: 't', customerId: 'c_weiye' });
    const products = await gateway.getProducts({ tenantId: 't', skus: ['XMAS-BALL-01'] });
    const order = await gateway.getOrder({ tenantId: 't', orderNo: 'SO-2026-0001' });

    expect(customer).not.toBeNull();
    expect(products).toHaveLength(1);
    expect(order).not.toBeNull();
    for (const record of [customer, products[0], order]) {
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(Object.isFrozen(order?.items)).toBe(true);

    // 严格模式下写入冻结对象会抛 TypeError，非严格模式下静默失败；两种情况下数据都不得改变。
    try {
      (customer as { name: string }).name = 'mutated';
    } catch {
      // strict mode: expected
    }
    expect((await gateway.getCustomer({ tenantId: 't', customerId: 'c_weiye' }))?.name).toBe(
      CUSTOMER_NAME,
    );
  });

  it('dispatches all six typed queries with the expected parameter mapping', async () => {
    const gateway = makeGateway();

    await expect(
      gateway.query({ tenantId: 't', operation: CRM_QUERY.customerSearch, params: { name: '伟业' } }),
    ).resolves.toHaveLength(1);
    await expect(
      gateway.query({
        tenantId: 't',
        operation: CRM_QUERY.customerGet,
        params: { customerId: 'c_weiye' },
      }),
    ).resolves.toMatchObject({ id: 'c_weiye' });
    await expect(
      gateway.query({
        tenantId: 't',
        operation: CRM_QUERY.creditGet,
        params: { customerId: 'c_weiye' },
      }),
    ).resolves.toMatchObject({ customer: { id: 'c_weiye' } });
    await expect(
      gateway.query({
        tenantId: 't',
        operation: CRM_QUERY.productsGet,
        params: { skus: ['XMAS-BALL-01'] },
      }),
    ).resolves.toHaveLength(1);
    await expect(
      gateway.query({ tenantId: 't', operation: CRM_QUERY.productsGet, params: { skus: 'XMAS-BALL-01' } }),
    ).resolves.toEqual([]);
    await expect(
      gateway.query({ tenantId: 't', operation: CRM_QUERY.productsSearch, params: { term: '圣诞' } }),
    ).resolves.toHaveLength(1);
    await expect(
      gateway.query({ tenantId: 't', operation: CRM_QUERY.orderGet, params: { orderId: 'o_1' } }),
    ).resolves.toMatchObject({ id: 'o_1' });
    await expect(
      gateway.query({
        tenantId: 't',
        operation: CRM_QUERY.orderGet,
        params: { orderNo: 'SO-2026-0001' },
      }),
    ).resolves.toMatchObject({ id: 'o_1' });
  });

  it('rejects unknown query operations', async () => {
    const gateway = makeGateway();
    await expect(
      gateway.query({ tenantId: 't', operation: 'unknown.operation', params: {} }),
    ).rejects.toThrow(/unsupported query operation/);
  });

  it('prefers the port tenantId over params.tenantId (fixture methods are tenant-agnostic)', async () => {
    const gateway = makeGateway();
    let receivedTenantId: string | undefined;
    const original = gateway.searchCustomers.bind(gateway);
    gateway.searchCustomers = async (input) => {
      receivedTenantId = input.tenantId;
      return original(input);
    };

    const rows = await gateway.query({
      tenantId: 't_port',
      operation: CRM_QUERY.customerSearch,
      params: { tenantId: 't_conflict', name: '伟业' },
    });

    // fixture 方法本身不校验租户（已知限制），因此这里只验证 dispatch 层：
    // 端口租户必须覆盖 params 中的冲突值，且查询仍返回预期数据。
    expect(receivedTenantId).toBe('t_port');
    expect(rows).toHaveLength(1);
  });

  it('records executeEffects without writing data', async () => {
    const gateway = makeGateway();
    const result = await gateway.executeEffects({
      tenantId: 't',
      idempotencyKey: 'idem_1',
      previewId: 'pv_1',
      traceId: 'tr_1',
      effects: [],
    });
    expect(result).toEqual({ ok: true, refs: {} });
    expect(gateway.calls).toEqual(['executeEffects']);
  });
});

import { describe, expect, it } from 'vitest';
import { CRM_QUERY } from '@lymtrix/vertical-crm-erp';
import { FixtureCrmGateway } from './fixtures';

const fixtures = {
  customers: [
    {
      id: 'c_weiye',
      name: '义乌市伟业进出口有限公司',
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
      customerName: '义乌市伟业进出口有限公司',
      items: [{ sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2 }],
      totalAmount: 200,
      balance: 200,
      termsDays: 30,
      status: 'committed',
      payments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

describe('FixtureCrmGateway', () => {
  const gateway = new FixtureCrmGateway(fixtures);

  it('searches customers by name and phone', async () => {
    expect(await gateway.searchCustomers({ tenantId: 't', name: '伟业' })).toHaveLength(1);
    expect(await gateway.searchCustomers({ tenantId: 't', phone: '13800000001' })).toHaveLength(1);
    expect(await gateway.searchCustomers({ tenantId: 't', name: '不存在' })).toHaveLength(0);
  });

  it('returns customer, credit, products and orders', async () => {
    expect((await gateway.getCustomer({ tenantId: 't', customerId: 'c_weiye' }))?.id).toBe('c_weiye');
    expect((await gateway.getCredit({ tenantId: 't', customerId: 'c_weiye' }))?.openOrders).toHaveLength(1);
    expect(await gateway.getProducts({ tenantId: 't', skus: ['XMAS-BALL-01'] })).toHaveLength(1);
    expect(await gateway.searchProducts({ tenantId: 't', term: '圣诞' })).toHaveLength(1);
    expect((await gateway.getOrder({ tenantId: 't', orderNo: 'SO-2026-0001' }))?.id).toBe('o_1');
  });

  it('dispatches typed queries by operation', async () => {
    await expect(
      gateway.query({ tenantId: 't', operation: CRM_QUERY.customerSearch, params: { name: '伟业' } }),
    ).resolves.toHaveLength(1);
    await expect(
      gateway.query({ tenantId: 't', operation: 'unknown.operation', params: {} }),
    ).rejects.toThrow(/unsupported query operation/);
  });

  it('records executeEffects without writing data', async () => {
    const result = await gateway.executeEffects({
      tenantId: 't',
      idempotencyKey: 'idem_1',
      previewId: 'pv_1',
      traceId: 'tr_1',
      effects: [],
    });
    expect(result).toEqual({ ok: true, refs: {} });
    expect(gateway.calls).toContain('executeEffects');
  });
});

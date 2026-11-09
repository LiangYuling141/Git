import { describe, expect, it } from 'vitest';
import { TefError, type ExecContext } from '@lymtrix/tef-core';
import { createOrderContract } from './create-order';
import { compensateOrderContract } from './compensate-order';
import type {
  CompensateOrderEvidence,
  CompensateOrderParams,
  CreateOrderEvidence,
  CustomerEvidence,
  OrderEvidence,
  PaymentEvidence,
  ProductEvidence,
} from './types';

// 与 create-order 测试使用同一个 §7.2 场景，保证补偿释放的数字能对上。
const SCENARIO_INPUT = {
  customerId: 'c_weiye_import',
  items: [{ sku: 'XMAS-BALL-01', quantity: 5000, unitPrice: 2 }],
  depositRate: 0.3,
  termsDays: 30,
};

function originalParams() {
  return createOrderContract.normalize(SCENARIO_INPUT);
}

function customer(overrides: Partial<CustomerEvidence> = {}): CustomerEvidence {
  return {
    id: 'c_weiye_import',
    name: '义乌市伟业进出口有限公司',
    status: 'active',
    customerType: 'normal',
    creditLimit: 50000,
    creditUsed: 47000,
    creditAvailable: 3000,
    overdueDays: 0,
    isHighRisk: false,
    ...overrides,
  };
}

function product(overrides: Partial<ProductEvidence> = {}): ProductEvidence {
  return {
    id: 'p_xmas_ball',
    sku: 'XMAS-BALL-01',
    name: '圣诞球 直径6cm 混色',
    unitPrice: 2,
    availableQty: 15000,
    reservedQty: 5000,
    unit: '个',
    ...overrides,
  };
}

function originalEvidence(): CreateOrderEvidence {
  return {
    queriedAt: '2026-11-07T00:00:00.000Z',
    customer: customer({ creditUsed: 40000, creditAvailable: 10000 }),
    products: [product({ availableQty: 20000, reservedQty: 0 })],
    missingSkus: [],
    overdueDaysThreshold: 30,
  };
}

function order(overrides: Partial<OrderEvidence> = {}): OrderEvidence {
  const p = originalParams();
  return {
    id: 'ord_1',
    orderNo: 'SO-1',
    status: 'confirmed',
    customerId: 'c_weiye_import',
    items: p.items,
    totalAmount: p.totalAmount,
    deposit: p.deposit,
    balance: p.balance,
    previewId: 'prev_1',
    traceId: 'tr_1',
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentEvidence> = {}): PaymentEvidence {
  return {
    id: 'pay_deposit',
    amount: 3000,
    method: 'transfer',
    status: 'pending',
    remark: '定金 30%',
    role: 'deposit',
    ...overrides,
  };
}

function evidence(overrides: Partial<CompensateOrderEvidence> = {}): CompensateOrderEvidence {
  return {
    queriedAt: '2026-11-08T00:00:00.000Z',
    order: order(),
    payments: [payment(), payment({ id: 'pay_balance', amount: 7000, method: 'credit', remark: '余款，30 天账期', role: 'balance' })],
    products: [product()],
    customer: customer(),
    original: {
      params: originalParams(),
      evidence: originalEvidence(),
      contractOperation: 'create_order',
      contractVersion: '1.0',
    },
    ...overrides,
  };
}

function ctx(overrides: Partial<ExecContext<never>> = {}): ExecContext<never> {
  return {
    tenantId: 't_yiwu_demo',
    userId: 'admin',
    sessionId: 's_1',
    role: 'owner',
    traceId: 'tr_1',
    timestampSnapshot: new Date('2026-11-08T00:00:00.000Z'),
    recentOpCount: 0,
    whitelistLevel: 'none',
    tenantThresholds: { amountL2Threshold: 5000, overdueDaysL2Threshold: 30 },
    db: null as never,
    ...overrides,
  };
}

function params(overrides: Partial<CompensateOrderParams> = {}): CompensateOrderParams {
  return { orderId: 'ord_1', ...overrides };
}

function failedChecks(checks: Array<{ id: string; ok: boolean; code: string }>): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.code);
}

describe('normalize', () => {
  it('保留订单与原因', () => {
    const p = compensateOrderContract.normalize({ orderId: 'ord_1', reason: '客户取消' });
    expect(p).toEqual({ orderId: 'ord_1', reason: '客户取消' });
  });

  it('原因可以缺省', () => {
    expect(compensateOrderContract.normalize({ orderId: 'ord_1' })).toEqual({ orderId: 'ord_1' });
  });

  it('缺 orderId 直接拒绝', () => {
    expect(() => compensateOrderContract.normalize({})).toThrow();
  });

  it('原因超过 500 字直接拒绝', () => {
    expect(() => compensateOrderContract.normalize({ orderId: 'ord_1', reason: 'x'.repeat(501) })).toThrow();
  });
});

describe('preconditions', () => {
  const p = params();

  it('正常场景全部通过', () => {
    expect(failedChecks(compensateOrderContract.preconditions(p, evidence()))).toEqual([]);
  });

  it('订单不存在 → ORDER_NOT_FOUND', () => {
    expect(failedChecks(compensateOrderContract.preconditions(p, evidence({ order: null })))).toContain(
      'ORDER_NOT_FOUND',
    );
  });

  it('订单已取消 → ORDER_NOT_COMPENSABLE', () => {
    expect(
      failedChecks(compensateOrderContract.preconditions(p, evidence({ order: order({ status: 'cancelled' }) }))),
    ).toContain('ORDER_NOT_COMPENSABLE');
  });

  it('订单已发货或完成 → ORDER_NOT_COMPENSABLE', () => {
    expect(
      failedChecks(compensateOrderContract.preconditions(p, evidence({ order: order({ status: 'shipped' }) }))),
    ).toContain('ORDER_NOT_COMPENSABLE');
    expect(
      failedChecks(compensateOrderContract.preconditions(p, evidence({ order: order({ status: 'completed' }) }))),
    ).toContain('ORDER_NOT_COMPENSABLE');
  });

  it('原始预览快照缺失 → ORIGINAL_EXECUTION_NOT_FOUND', () => {
    expect(failedChecks(compensateOrderContract.preconditions(p, evidence({ original: null })))).toContain(
      'ORIGINAL_EXECUTION_NOT_FOUND',
    );
  });

  it('订单金额与原始快照不一致 → ORDER_ORIGINAL_MISMATCH', () => {
    expect(
      failedChecks(compensateOrderContract.preconditions(p, evidence({ order: order({ totalAmount: 1 }) }))),
    ).toContain('ORDER_ORIGINAL_MISMATCH');
  });

  it('已有收款完成 → PAYMENT_ALREADY_COLLECTED', () => {
    const ev = evidence({
      payments: [
        payment(),
        payment({ id: 'pay_balance', amount: 7000, method: 'credit', remark: '余款', role: 'balance', status: 'completed' }),
      ],
    });
    expect(failedChecks(compensateOrderContract.preconditions(p, ev))).toContain('PAYMENT_ALREADY_COLLECTED');
  });

  it('定金或余款计划缺失 → PAYMENT_PLAN_INCONSISTENT', () => {
    expect(failedChecks(compensateOrderContract.preconditions(p, evidence({ payments: [] })))).toContain(
      'PAYMENT_PLAN_INCONSISTENT',
    );
  });

  it('库存预占已被消耗 → RESERVED_INVENTORY_INSUFFICIENT', () => {
    const ev = evidence({ products: [product({ reservedQty: 1000 })] });
    expect(failedChecks(compensateOrderContract.preconditions(p, ev))).toContain(
      'RESERVED_INVENTORY_INSUFFICIENT',
    );
  });

  it('信用占用少于订单余款 → CREDIT_STATE_INCONSISTENT', () => {
    const ev = evidence({ customer: customer({ creditUsed: 1000 }) });
    expect(failedChecks(compensateOrderContract.preconditions(p, ev))).toContain('CREDIT_STATE_INCONSISTENT');
  });

  it('商品档案缺失 → PRODUCT_NOT_FOUND', () => {
    expect(failedChecks(compensateOrderContract.preconditions(p, evidence({ products: [] })))).toContain(
      'PRODUCT_NOT_FOUND',
    );
  });
});

describe('invariants', () => {
  it('正常证据全部成立', () => {
    expect(failedChecks(compensateOrderContract.invariants(params(), evidence()))).toEqual([]);
  });

  it('订单明细与原始参数不一致 → ORDER_ITEM_MISMATCH', () => {
    const tampered = order({
      items: [{ sku: 'XMAS-BALL-01', quantity: 1, unitPrice: 2, subtotal: 2 }],
    });
    expect(
      failedChecks(compensateOrderContract.invariants(params(), evidence({ order: tampered }))),
    ).toContain('ORDER_ITEM_MISMATCH');
  });

  it('收款计划合计与订单总额不一致 → PAYMENT_PLAN_MISMATCH', () => {
    const ev = evidence({
      payments: [
        payment({ amount: 1 }),
        payment({ id: 'pay_balance', amount: 7000, method: 'credit', remark: '余款', role: 'balance' }),
      ],
    });
    expect(failedChecks(compensateOrderContract.invariants(params(), ev))).toContain('PAYMENT_PLAN_MISMATCH');
  });
});

describe('permissions', () => {
  it.each([
    ['owner', true],
    ['sales', true],
    ['finance', false],
    ['viewer', false],
  ] as const)('角色 %s → %s', (role, allowed) => {
    const checks = compensateOrderContract.permissions(params(), ctx({ role }));
    expect(checks[0]?.ok).toBe(allowed);
    if (!allowed) expect(checks[0]?.code).toBe('PERMISSION_DENIED');
  });
});

describe('riskRules', () => {
  it('补偿始终是 L2，不受金额与白名单影响', () => {
    const result = compensateOrderContract.riskRules(params(), evidence(), ctx({ whitelistLevel: 'WL3' }));
    expect(result.level).toBe('L2');
    expect(result.reasons.join(' ')).toContain('compensation_requires_human_approval');
  });

  it('是纯函数：同一输入重复调用结果一致', () => {
    const ev = evidence();
    const c = ctx();
    expect(compensateOrderContract.riskRules(params(), ev, c)).toEqual(
      compensateOrderContract.riskRules(params(), ev, c),
    );
  });
});

describe('effects', () => {
  it('复用原契约的补偿声明：作废订单、作废收款、释放库存、归还额度', () => {
    const list = compensateOrderContract.effects(params(), evidence());
    expect(list.map((e) => `${e.type}:${e.entity}`)).toEqual([
      'update:order',
      'update:payment',
      'update:payment',
      'release:product',
      'update:customer',
    ]);
    expect(list[0]).toMatchObject({ target: 'ord_1', payload: { status: 'cancelled' } });
    expect(list[1]).toMatchObject({ target: 'pay_deposit', payload: { status: 'voided' } });
    expect(list[2]).toMatchObject({ target: 'pay_balance', payload: { status: 'voided' } });
    expect(list[3]?.increment).toEqual({ reservedQty: -5000, availableQty: 5000 });
    expect(list[4]?.increment).toEqual({ creditUsed: -7000 });
  });

  it('全额预付的订单不产生收款作废动作', () => {
    const p = createOrderContract.normalize({ ...SCENARIO_INPUT, depositRate: 1 });
    const ev = evidence({
      order: order({ totalAmount: p.totalAmount, deposit: p.deposit, balance: p.balance, items: p.items }),
      payments: [payment({ id: 'pay_full', amount: 10000 })],
      original: {
        params: p,
        evidence: originalEvidence(),
        contractOperation: 'create_order',
        contractVersion: '1.0',
      },
    });
    const list = compensateOrderContract.effects(params(), ev);
    expect(list.map((e) => `${e.type}:${e.entity}`)).toEqual([
      'update:order',
      'update:payment',
      'release:product',
    ]);
  });

  it('补偿的补偿为空，避免递归', () => {
    expect(compensateOrderContract.compensation(params(), evidence(), { ok: true, refs: {} })).toEqual([]);
  });
});

describe('diff', () => {
  it('给出人能直接核对的取消、作废、释放与归还摘要', () => {
    const entries = compensateOrderContract.diff?.(params(), evidence()) ?? [];
    expect(entries.map((entry) => entry.label)).toEqual([
      '取消订单 SO-1（总额 ¥10000.00）',
      '作废定金收款计划 ¥3000.00',
      '作废余款收款计划 ¥7000.00',
      '释放库存 圣诞球 直径6cm 混色 5000个',
      '归还信用额度 ¥7000.00',
    ]);
  });

  it('before/after 来自服务端证据', () => {
    const entries = compensateOrderContract.diff?.(params(), evidence()) ?? [];
    expect(entries[0]?.changes).toEqual([
      { field: 'status', before: 'confirmed', after: 'cancelled' },
    ]);
    expect(entries[3]?.changes).toEqual([
      { field: 'reservedQty', before: 5000, after: 0 },
      { field: 'availableQty', before: 15000, after: 20000 },
    ]);
  });
});

describe('registration', () => {
  it('registerCreditOrderContracts 同时注册 create_order 与 compensate_order', async () => {
    const { registerCreditOrderContracts } = await import('./index');
    const { contractRegistry } = await import('@lymtrix/tef-core');
    registerCreditOrderContracts();
    expect(contractRegistry.get('create_order', '1.0')).toBeDefined();
    expect(contractRegistry.get('compensate_order', '1.0')).toBeDefined();
  });
});

describe('audit', () => {
  it('subjectRef 是订单假名，before/after 只含状态、库存与额度', () => {
    const spec = compensateOrderContract.audit(params(), evidence(), null);
    expect(spec.subjectRef).toBe('order:ord_1');
    expect(spec.before).toEqual({
      orderStatus: 'confirmed',
      paymentStatuses: { pay_deposit: 'pending', pay_balance: 'pending' },
      inventory: { 'XMAS-BALL-01': 5000 },
      creditUsed: 47000,
    });
    expect(spec.retainDays).toBe(1095);
  });

  it('审计规格里不出现客户名称或电话', () => {
    const serialized = JSON.stringify(compensateOrderContract.audit(params(), evidence(), { ok: true, refs: {} }));
    expect(serialized).not.toContain('义乌市伟业进出口有限公司');
    expect(serialized).not.toContain('13905791001');
  });

  it('执行后给出 after 快照', () => {
    const spec = compensateOrderContract.audit(params(), evidence(), { ok: true, refs: {} });
    expect(spec.after).toEqual({
      orderStatus: 'cancelled',
      paymentStatuses: { pay_deposit: 'voided', pay_balance: 'voided' },
      inventory: { 'XMAS-BALL-01': 0 },
      creditUsed: 40000,
    });
  });
});

describe('loadEvidence（fail-closed）', () => {
  it('缺少 ctx.gateway 时抛 INTERNAL，且在访问 ctx.db 之前', async () => {
    let dbTouched = false;
    const db = new Proxy(
      {},
      {
        get() {
          dbTouched = true;
          throw new Error('ctx.db must not be touched');
        },
      },
    ) as never;

    const error = await compensateOrderContract.loadEvidence(params(), ctx({ db })).then(
      () => {
        throw new Error('expected loadEvidence to reject, but it resolved');
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(TefError);
    expect((error as TefError).code).toBe('INTERNAL');
    expect((error as TefError).message).toBe('BusinessGateway is not configured');
    expect(dbTouched).toBe(false);
  });
});

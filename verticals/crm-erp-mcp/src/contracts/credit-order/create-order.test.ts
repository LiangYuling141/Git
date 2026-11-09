import { describe, expect, it } from 'vitest';
import type { ExecContext } from '@lymatrix/tef-core';
import { createOrderContract } from './create-order';
import type { CreateOrderEvidence, CreateOrderParams, CustomerEvidence, ProductEvidence } from './types';

// 说明书 §7.2 的场景：5000 个圣诞球，单价 2 元，30% 定金，30 天账期。
const SCENARIO_INPUT = {
  customerId: 'c_weiye_import',
  items: [{ sku: 'XMAS-BALL-01', quantity: 5000, unitPrice: 2 }],
  depositRate: 0.3,
  termsDays: 30,
};

function customer(overrides: Partial<CustomerEvidence> = {}): CustomerEvidence {
  return {
    id: 'c_weiye_import',
    name: '义乌市伟业进出口有限公司',
    status: 'active',
    customerType: 'normal',
    creditLimit: 50000,
    creditUsed: 40000,
    creditAvailable: 10000,
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
    availableQty: 20000,
    reservedQty: 0,
    unit: '个',
    ...overrides,
  };
}

function evidence(overrides: Partial<CreateOrderEvidence> = {}): CreateOrderEvidence {
  return {
    queriedAt: '2026-11-07T00:00:00.000Z',
    customer: customer(),
    products: [product()],
    missingSkus: [],
    overdueDaysThreshold: 30,
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
    timestampSnapshot: new Date('2026-11-07T00:00:00.000Z'),
    recentOpCount: 0,
    whitelistLevel: 'none',
    tenantThresholds: { amountL2Threshold: 5000, overdueDaysL2Threshold: 30 },
    db: null as never,
    ...overrides,
  };
}

function normalized(overrides: Partial<CreateOrderParams> = {}): CreateOrderParams {
  const base = createOrderContract.normalize(SCENARIO_INPUT);
  return { ...base, ...overrides };
}

function failedChecks(checks: Array<{ id: string; ok: boolean; code: string }>): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.code);
}

describe('normalize：金额在整数分上运算', () => {
  it('复现说明书 §7.2 的数字', () => {
    const p = createOrderContract.normalize(SCENARIO_INPUT);
    expect(p.totalAmount).toBe(10000);
    expect(p.deposit).toBe(3000);
    expect(p.balance).toBe(7000);
    expect(p.termsDays).toBe(30);
    expect(p.items[0]?.subtotal).toBe(10000);
  });

  it('浮点噪声不会让合计出现 0.30000000000000004', () => {
    const p = createOrderContract.normalize({
      customerId: 'c_1',
      items: [{ sku: 'A', quantity: 3, unitPrice: 0.1 }],
    });
    expect(p.totalAmount).toBe(0.3);
  });

  it('缺省 depositRate 为 0，全额成为余款', () => {
    const p = createOrderContract.normalize({ customerId: 'c_1', items: [{ sku: 'A', quantity: 1, unitPrice: 100 }] });
    expect(p.depositRate).toBe(0);
    expect(p.deposit).toBe(0);
    expect(p.balance).toBe(100);
  });

  it('depositRate = 1 时没有余款，也就不占用信用额度', () => {
    const p = createOrderContract.normalize({ ...SCENARIO_INPUT, depositRate: 1 });
    expect(p.deposit).toBe(10000);
    expect(p.balance).toBe(0);
  });

  it('折扣超过明细合计直接拒绝', () => {
    expect(() => createOrderContract.normalize({ ...SCENARIO_INPUT, discount: 20000 })).toThrow(/exceeds line total/);
  });

  it('缺单价直接拒绝：单价要进 intentHash，模型不能靠猜', () => {
    expect(() =>
      createOrderContract.normalize({ customerId: 'c_1', items: [{ sku: 'A', quantity: 1 }] }),
    ).toThrow();
  });

  it('多 SKU 合并计算', () => {
    const p = createOrderContract.normalize({
      customerId: 'c_1',
      items: [
        { sku: 'A', quantity: 2, unitPrice: 10.5 },
        { sku: 'B', quantity: 1, unitPrice: 4 },
      ],
      depositRate: 0.5,
    });
    expect(p.totalAmount).toBe(25);
    expect(p.deposit).toBe(12.5);
    expect(p.balance).toBe(12.5);
  });
});

describe('preconditions', () => {
  const p = normalized();

  it('正常场景全部通过', () => {
    expect(failedChecks(createOrderContract.preconditions(p, evidence()))).toEqual([]);
  });

  it('客户不存在 → NOT_FOUND', () => {
    const checks = createOrderContract.preconditions(p, evidence({ customer: null }));
    expect(failedChecks(checks)).toContain('NOT_FOUND');
  });

  it('客户被停用 → CUSTOMER_INACTIVE', () => {
    const checks = createOrderContract.preconditions(p, evidence({ customer: customer({ status: 'frozen' }) }));
    expect(failedChecks(checks)).toContain('CUSTOMER_INACTIVE');
  });

  it('可用额度不足余款 → INSUFFICIENT_CREDIT，并给出人能看懂的数字', () => {
    const ev = evidence({ customer: customer({ creditLimit: 50000, creditUsed: 47000, creditAvailable: 3000 }) });
    const checks = createOrderContract.preconditions(p, ev);
    const credit = checks.find((c) => c.id === 'customer.credit_available_sufficient');
    expect(credit?.ok).toBe(false);
    expect(credit?.code).toBe('INSUFFICIENT_CREDIT');
    expect(credit?.message).toContain('¥3000.00');
    expect(credit?.message).toContain('¥7000.00');
  });

  it('额度刚好等于余款时放行（边界值）', () => {
    const ev = evidence({ customer: customer({ creditUsed: 43000, creditAvailable: 7000 }) });
    expect(failedChecks(createOrderContract.preconditions(p, ev))).toEqual([]);
  });

  it('库存不足 → INSUFFICIENT_INVENTORY', () => {
    const ev = evidence({ products: [product({ availableQty: 300 })] });
    const checks = createOrderContract.preconditions(p, ev);
    expect(failedChecks(checks)).toContain('INSUFFICIENT_INVENTORY');
  });

  it('同一 SKU 分多行时按合计需求量校验', () => {
    const multi = normalized({
      items: [
        { sku: 'XMAS-BALL-01', quantity: 3000, unitPrice: 2, subtotal: 6000 },
        { sku: 'XMAS-BALL-01', quantity: 3000, unitPrice: 2, subtotal: 6000 },
      ],
    });
    const ev = evidence({ products: [product({ availableQty: 5000 })] });
    expect(failedChecks(createOrderContract.preconditions(multi, ev))).toContain('INSUFFICIENT_INVENTORY');
  });

  it('单价与商品档案不符 → PRICE_MISMATCH：这是模型私自改价的拦截点', () => {
    const cheap = normalized({
      items: [{ sku: 'XMAS-BALL-01', quantity: 5000, unitPrice: 0.2, subtotal: 1000 }],
      totalAmount: 1000,
      deposit: 300,
      balance: 700,
    });
    const checks = createOrderContract.preconditions(cheap, evidence());
    const mismatch = checks.find((c) => c.id === 'product.price_matches_master');
    expect(mismatch?.ok).toBe(false);
    expect(mismatch?.message).toContain('¥0.20');
    expect(mismatch?.message).toContain('¥2.00');
  });

  it('未知 SKU → UNKNOWN_SKU', () => {
    const ev = evidence({ products: [], missingSkus: ['XMAS-BALL-01'] });
    expect(failedChecks(createOrderContract.preconditions(p, ev))).toContain('UNKNOWN_SKU');
  });
});

describe('invariants', () => {
  it('正常参数全部成立', () => {
    expect(failedChecks(createOrderContract.invariants(normalized(), evidence()))).toEqual([]);
  });

  it('快照里的总额被改过 → TOTAL_MISMATCH', () => {
    const tampered = normalized({ totalAmount: 99999 });
    expect(failedChecks(createOrderContract.invariants(tampered, evidence()))).toContain('TOTAL_MISMATCH');
  });

  it('定金被改过 → DEPOSIT_MISMATCH', () => {
    expect(failedChecks(createOrderContract.invariants(normalized({ deposit: 1 }), evidence()))).toContain(
      'DEPOSIT_MISMATCH',
    );
  });

  it('余款与总额−定金不符 → BALANCE_MISMATCH', () => {
    expect(failedChecks(createOrderContract.invariants(normalized({ balance: 1 }), evidence()))).toContain(
      'BALANCE_MISMATCH',
    );
  });

  it('负总额 → NEGATIVE_TOTAL', () => {
    expect(
      failedChecks(createOrderContract.invariants(normalized({ totalAmount: -1, deposit: 0, balance: -1 }), evidence())),
    ).toContain('NEGATIVE_TOTAL');
  });

  it('定金比例越界 → INVALID_DEPOSIT_RATE', () => {
    expect(failedChecks(createOrderContract.invariants(normalized({ depositRate: 1.5 }), evidence()))).toContain(
      'INVALID_DEPOSIT_RATE',
    );
  });
});

describe('permissions（§11.2 角色 scope）', () => {
  const p = normalized();

  it.each([
    ['owner', true],
    ['sales', true],
    ['finance', false],
    ['viewer', false],
  ] as const)('角色 %s → %s', (role, allowed) => {
    const checks = createOrderContract.permissions(p, ctx({ role }));
    expect(checks[0]?.ok).toBe(allowed);
    if (!allowed) expect(checks[0]?.code).toBe('PERMISSION_DENIED');
  });
});

describe('riskRules（§3.2 判定顺序）', () => {
  const p = normalized();

  it('说明书场景：总额 10,000 超过租户阈值 5,000 → L2', () => {
    const result = createOrderContract.riskRules(p, evidence(), ctx());
    expect(result.level).toBe('L2');
    expect(result.reasons.join(' ')).toContain('threshold 5000');
  });

  it('小额无折扣订单 → L1，走 preview→execute 但不需要人工确认', () => {
    const small = createOrderContract.normalize({
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2 }],
    });
    expect(createOrderContract.riskRules(small, evidence(), ctx()).level).toBe('L1');
  });

  it('带折扣 → 命中敏感字段 discount，升 L2', () => {
    const discounted = createOrderContract.normalize({ ...SCENARIO_INPUT, discount: 100 });
    const result = createOrderContract.riskRules(discounted, evidence(), ctx());
    expect(result.level).toBe('L2');
    expect(result.reasons.join(' ')).toContain('sensitive_fields:discount');
  });

  it('逾期 45 天超过租户阈值 30 → L2', () => {
    const ev = evidence({ customer: customer({ overdueDays: 45, creditUsed: 0, creditAvailable: 50000 }) });
    const small = createOrderContract.normalize({
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2 }],
    });
    const result = createOrderContract.riskRules(small, ev, ctx());
    expect(result.level).toBe('L2');
    expect(result.reasons.join(' ')).toContain('overdue_days 45 > 30');
  });

  it('可用额度小于订单总额 → L2', () => {
    const ev = evidence({ customer: customer({ creditLimit: 50000, creditUsed: 45000, creditAvailable: 5000 }) });
    const small = createOrderContract.normalize({
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 3000, unitPrice: 2 }],
    });
    const result = createOrderContract.riskRules(small, ev, ctx());
    expect(result.level).toBe('L2');
    expect(result.reasons.join(' ')).toContain('credit_available');
  });

  it('high_risk 客户 → L2', () => {
    const ev = evidence({ customer: customer({ customerType: 'high_risk', isHighRisk: true }) });
    const small = createOrderContract.normalize({
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 10, unitPrice: 2 }],
    });
    expect(createOrderContract.riskRules(small, ev, ctx()).level).toBe('L2');
  });

  it('WL3 白名单也不能豁免逾期触发的 L2（§3.3：白名单只调阈值）', () => {
    const ev = evidence({ customer: customer({ overdueDays: 45, creditUsed: 0, creditAvailable: 50000 }) });
    const small = createOrderContract.normalize({
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2 }],
    });
    expect(createOrderContract.riskRules(small, ev, ctx({ whitelistLevel: 'WL3' })).level).toBe('L2');
  });

  it('WL3 提高金额阈值后，原本 L2 的订单可以降为 L1——但确认协议不变', () => {
    // 10,000 < 5,000 × 2 = 10,000 不成立（严格大于），所以仍是 L2；
    // 换成 9,000 才能看到阈值上调的效果。
    const mid = createOrderContract.normalize({
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 4500, unitPrice: 2 }],
    });
    expect(createOrderContract.riskRules(mid, evidence(), ctx()).level).toBe('L2');
    expect(createOrderContract.riskRules(mid, evidence(), ctx({ whitelistLevel: 'WL3' })).level).toBe('L1');
  });

  it('客户不存在时不崩溃，按 normal 处理', () => {
    const result = createOrderContract.riskRules(p, evidence({ customer: null }), ctx());
    expect(result.level).toBe('L2');
  });

  it('非法金额 → Block，且不可被白名单降级', () => {
    const bad = normalized({ totalAmount: -1 });
    expect(createOrderContract.riskRules(bad, evidence(), ctx()).level).toBe('Block');
    expect(createOrderContract.riskRules(bad, evidence(), ctx({ whitelistLevel: 'WL3' })).level).toBe('Block');
  });

  it('是纯函数：同一输入重复调用结果一致', () => {
    const ev = evidence();
    const c = ctx();
    expect(createOrderContract.riskRules(p, ev, c)).toEqual(createOrderContract.riskRules(p, ev, c));
  });
});

describe('effects', () => {
  it('赊账订单产生：建单 + 定金计划 + 余款计划 + 预占库存 + 占用额度', () => {
    const list = createOrderContract.effects(normalized(), evidence());
    expect(list.map((e) => `${e.type}:${e.entity}`)).toEqual([
      'create:order',
      'create:payment',
      'create:payment',
      'reserve:product',
      'update:customer',
    ]);
  });

  it('收款计划通过 bind 引用新建订单的 id，而不是靠字符串模板', () => {
    const list = createOrderContract.effects(normalized(), evidence());
    expect(list[1]?.bind).toEqual({ orderId: { fromRef: 'order', field: 'id' } });
    expect(list[2]?.bind).toEqual({ orderId: { fromRef: 'order', field: 'id' } });
  });

  it('余款带账期，定金即时到期', () => {
    const list = createOrderContract.effects(normalized(), evidence());
    expect(list[1]?.payload).toMatchObject({ amount: 3000, method: 'transfer', dueInDays: 0 });
    expect(list[2]?.payload).toMatchObject({ amount: 7000, method: 'credit', dueInDays: 30 });
  });

  it('库存预占是声明式增量，且目标是证据里的商品主键', () => {
    const list = createOrderContract.effects(normalized(), evidence());
    const reserve = list.find((e) => e.type === 'reserve');
    expect(reserve?.target).toBe('p_xmas_ball');
    expect(reserve?.increment).toEqual({ reservedQty: 5000, availableQty: -5000 });
  });

  it('只占用余款部分的信用额度，不占用定金', () => {
    const list = createOrderContract.effects(normalized(), evidence());
    expect(list.find((e) => e.entity === 'customer')?.increment).toEqual({ creditUsed: 7000 });
  });

  it('全额预付时不建余款计划、不占额度', () => {
    const p = createOrderContract.normalize({ ...SCENARIO_INPUT, depositRate: 1 });
    const list = createOrderContract.effects(p, evidence());
    expect(list.map((e) => `${e.type}:${e.entity}`)).toEqual(['create:order', 'create:payment', 'reserve:product']);
  });

  it('多 SKU 各自预占', () => {
    const p = normalized({
      items: [
        { sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2, subtotal: 200 },
        { sku: 'LED-STRING-02', quantity: 10, unitPrice: 8.5, subtotal: 85 },
      ],
      totalAmount: 285,
      deposit: 0,
      balance: 285,
    });
    const ev = evidence({
      products: [product(), product({ id: 'p_led', sku: 'LED-STRING-02', name: 'LED 灯串', unitPrice: 8.5, availableQty: 5000, unit: '条' })],
    });
    const reserves = createOrderContract.effects(p, ev).filter((e) => e.type === 'reserve');
    expect(reserves).toHaveLength(2);
    expect(reserves[1]?.increment).toEqual({ reservedQty: 10, availableQty: -10 });
  });
});

describe('compensation', () => {
  it('沿 effects 反向撤销：作废订单、作废收款计划、释放预占、归还额度', () => {
    const p = normalized();
    const ev = evidence();
    const execResult = {
      ok: true,
      refs: { order: { id: 'ord_1' }, depositPayment: { id: 'pay_1' }, balancePayment: { id: 'pay_2' } },
    };
    const list = createOrderContract.compensation(p, ev, execResult);

    expect(list.map((e) => `${e.type}:${e.entity}`)).toEqual([
      'update:order',
      'update:payment',
      'update:payment',
      'release:product',
      'update:customer',
    ]);
    expect(list[0]).toMatchObject({ target: 'ord_1', payload: { status: 'cancelled' } });
    expect(list[1]).toMatchObject({ target: 'pay_1', payload: { status: 'voided' } });
    expect(list[3]?.increment).toEqual({ reservedQty: -5000, availableQty: 5000 });
    expect(list[4]?.increment).toEqual({ creditUsed: -7000 });
  });

  it('补偿是幂等的：不依赖执行时产生的临时状态', () => {
    const p = normalized();
    const execResult = { ok: true, refs: { order: { id: 'ord_1' } } };
    const first = createOrderContract.compensation(p, evidence(), execResult);
    const second = createOrderContract.compensation(p, evidence(), execResult);
    expect(second).toEqual(first);
  });

  it('执行没产生任何产物时补偿也不会抛错', () => {
    expect(() => createOrderContract.compensation(normalized(), evidence(), { ok: false, refs: {} })).not.toThrow();
  });
});

describe('diff（确认页展示服务端 diff，不用模型摘要替代）', () => {
  it('给出人能直接核对的中文摘要', () => {
    const entries = createOrderContract.diff?.(normalized(), evidence()) ?? [];
    expect(entries[0]?.label).toContain('义乌市伟业进出口有限公司');
    expect(entries[0]?.label).toContain('¥10000.00');
    expect(entries[0]?.payload?.items).toEqual(['圣诞球 直径6cm 混色 × 5000个 @ ¥2.00']);
  });

  it('库存与额度的 before/after 都来自服务端证据', () => {
    const entries = createOrderContract.diff?.(normalized(), evidence()) ?? [];
    const reserve = entries.find((e) => e.action === 'reserve');
    expect(reserve?.changes).toEqual([{ field: 'availableQty', before: 20000, after: 15000 }]);
    const credit = entries.find((e) => e.entity === 'customer');
    expect(credit?.changes).toEqual([
      { field: 'creditUsed', before: 40000, after: 47000 },
      { field: 'creditAvailable', before: 10000, after: 3000 },
    ]);
  });
});

describe('audit（§10.2：审计事件不得存直接个人信息）', () => {
  it('subjectRef 是假名，before/after 只含额度与库存', () => {
    const spec = createOrderContract.audit(normalized(), evidence(), null);
    expect(spec.subjectRef).toBe('cust:c_weiye_import');
    expect(spec.before).toEqual({
      creditAvailable: 10000,
      creditUsed: 40000,
      inventory: { 'XMAS-BALL-01': 20000 },
    });
    expect(spec.retainDays).toBe(1095);
  });

  it('审计规格里不出现客户名称、电话或地址', () => {
    const spec = createOrderContract.audit(normalized(), evidence(), { ok: true, refs: {} });
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain('义乌市伟业进出口有限公司');
    expect(serialized).not.toContain('13905791001');
  });

  it('执行后给出 after 快照', () => {
    const spec = createOrderContract.audit(normalized(), evidence(), { ok: true, refs: {} });
    expect(spec.after).toEqual({
      creditAvailable: 3000,
      creditUsed: 47000,
      inventory: { 'XMAS-BALL-01': 15000 },
    });
  });
});

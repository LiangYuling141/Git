import { describe, expect, it } from 'vitest';
import { DEFAULT_AMOUNT_L2_THRESHOLD, classifyRisk, resolveAmountThreshold } from './risk';
import type { RiskInput } from './types';

function input(overrides: Partial<RiskInput> = {}, context: Partial<RiskInput['context']> = {}): RiskInput {
  return {
    opType: 'create',
    entity: 'order',
    fields: [],
    amount: 1000,
    customer: { type: 'normal', overdueDays: 0, creditAvailable: 100000 },
    context: {
      timestampSnapshot: new Date('2026-11-07T00:00:00.000Z'),
      recentOpCount: 0,
      whitelistLevel: 'none',
      tenantThresholds: { amountL2Threshold: 5000 },
      ...context,
    },
    ...overrides,
  };
}

describe('classifyRisk 判定顺序（§3.2）', () => {
  it('只读查询恒为 L0', () => {
    expect(classifyRisk(input({ opType: 'query', amount: 999999 })).level).toBe('L0');
  });

  it('金额超过租户阈值 → L2', () => {
    const result = classifyRisk(input({ amount: 10000 }));
    expect(result.level).toBe('L2');
    expect(result.reasons.join(' ')).toContain('threshold 5000');
  });

  it('金额未超阈值且无其他因子 → L1', () => {
    expect(classifyRisk(input({ amount: 5000 })).level).toBe('L1');
  });

  it('命中敏感字段 → L2，即使金额很小', () => {
    expect(classifyRisk(input({ amount: 1, fields: ['creditLimit'] })).level).toBe('L2');
    expect(classifyRisk(input({ amount: 1, fields: ['discount'] })).level).toBe('L2');
  });

  it('客户为 high_risk / restricted → L2', () => {
    expect(classifyRisk(input({ customer: { type: 'high_risk', overdueDays: 0, creditAvailable: 0 } })).level).toBe('L2');
    expect(classifyRisk(input({ customer: { type: 'restricted', overdueDays: 0, creditAvailable: 0 } })).level).toBe('L2');
  });

  it('普通客户 + 小金额 + 无敏感字段 → L1', () => {
    expect(classifyRisk(input()).level).toBe('L1');
  });
});

describe('Block 优先级最高且不可降级', () => {
  it('非法操作类型 → Block', () => {
    const result = classifyRisk(input({ opType: 'destroy' as never }));
    expect(result.level).toBe('Block');
    expect(result.reasons.join(' ')).toContain('unknown_op_type');
  });

  it('金额为负或非有限 → Block', () => {
    expect(classifyRisk(input({ amount: -1 })).level).toBe('Block');
    expect(classifyRisk(input({ amount: Number.NaN })).level).toBe('Block');
    expect(classifyRisk(input({ amount: Number.POSITIVE_INFINITY })).level).toBe('Block');
  });

  it('WL3 白名单也不能把 Block 降级（§3.3）', () => {
    const blocked = input({ amount: -1 }, { whitelistLevel: 'WL3' });
    expect(classifyRisk(blocked).level).toBe('Block');
  });

  it('WL3 白名单也不能让查询变成非 L0', () => {
    expect(classifyRisk(input({ opType: 'query' }, { whitelistLevel: 'WL3' })).level).toBe('L0');
  });

  it('白名单只提高金额阈值，不能豁免敏感字段触发的 L2', () => {
    const result = classifyRisk(input({ amount: 1, fields: ['price'] }, { whitelistLevel: 'WL3' }));
    expect(result.level).toBe('L2');
  });

  it('白名单不能豁免 high_risk 客户触发的 L2', () => {
    const result = classifyRisk(
      input({ customer: { type: 'high_risk', overdueDays: 90, creditAvailable: 0 } }, { whitelistLevel: 'WL3' }),
    );
    expect(result.level).toBe('L2');
  });
});

describe('阈值解析', () => {
  it('租户未配置阈值时回落到框架默认值', () => {
    expect(resolveAmountThreshold(input({}, { tenantThresholds: {} }))).toBe(DEFAULT_AMOUNT_L2_THRESHOLD);
  });

  it('白名单等级只影响金额阈值这一比较基准', () => {
    expect(resolveAmountThreshold(input({}, { whitelistLevel: 'none' }))).toBe(5000);
    expect(resolveAmountThreshold(input({}, { whitelistLevel: 'WL2' }))).toBe(7500);
    expect(resolveAmountThreshold(input({}, { whitelistLevel: 'WL3' }))).toBe(10000);
  });

  it('阈值提高后原本 L2 的金额可以变成 L1——但确认协议本身不受影响', () => {
    expect(classifyRisk(input({ amount: 8000 })).level).toBe('L2');
    expect(classifyRisk(input({ amount: 8000 }, { whitelistLevel: 'WL3' })).level).toBe('L1');
  });
});

describe('纯函数性（§3.1）', () => {
  it('同一输入重复调用结果完全一致', () => {
    const frozen = input({ amount: 10000 });
    const first = classifyRisk(frozen);
    const second = classifyRisk(frozen);
    expect(second).toEqual(first);
  });

  it('不读墙上时钟：跨越真实时间后结果不变', async () => {
    const frozen = input({ amount: 10000 });
    const before = classifyRisk(frozen);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = classifyRisk(frozen);
    expect(after).toEqual(before);
  });

  it('不修改输入', () => {
    const frozen = input({ amount: 10000, fields: ['discount'] });
    const snapshot = JSON.stringify(frozen);
    classifyRisk(frozen);
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it('timestampSnapshot 与 recentOpCount 不参与当前判定顺序，但改变它们不改变结果', () => {
    const base = classifyRisk(input({ amount: 10000 }));
    const shifted = classifyRisk(
      input({ amount: 10000 }, { timestampSnapshot: new Date('2030-01-01T00:00:00Z'), recentOpCount: 999 }),
    );
    expect(shifted).toEqual(base);
  });
});

import { describe, expect, it } from 'vitest';
import type { EvalSample } from './sample';
import { runOfflineSample } from './offline';

const customer = {
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
};

const product = {
  id: 'p_ball',
  sku: 'XMAS-BALL-01',
  name: '圣诞球',
  unitPrice: 2,
  availableQty: 20000,
  reservedQty: 0,
  unit: '个',
};

function sample(overrides: Partial<EvalSample> = {}): EvalSample {
  return {
    id: 'normal_l1_order',
    category: 'normal',
    tenant: { thresholds: { amountL2Threshold: 5000 } },
    principal: { userId: 'u_eval', role: 'owner' },
    input: { messages: ['给伟业公司下 100 个圣诞球，单价 2 块'] },
    intent: {
      contract: 'create_order',
      slots: {
        customerId: 'c_weiye',
        items: [{ sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2 }],
      },
    },
    fixtures: { customers: [customer], products: [product], orders: [] },
    expect: { decision: 'allow', risk: 'L1', contract: 'create_order' },
    tags: ['normal'],
    ...overrides,
  };
}

describe('offline eval layer', () => {
  it('returns allow for an L1 order', async () => {
    const outcome = await runOfflineSample(sample());
    expect(outcome.actual.decision).toBe('allow');
    expect(outcome.actual.risk).toBe('L1');
    expect(outcome.intentSource).toBe('annotated');
    expect(outcome.traceId).toBe('tr_eval_normal_l1_order');
  });

  it('returns confirm for an L2 order', async () => {
    const outcome = await runOfflineSample(
      sample({
        intent: {
          contract: 'create_order',
          slots: {
            customerId: 'c_weiye',
            items: [{ sku: 'XMAS-BALL-01', quantity: 5000, unitPrice: 2 }],
            depositRate: 0.3,
            termsDays: 30,
          },
        },
        expect: { decision: 'confirm', risk: 'L2', contract: 'create_order' },
      }),
    );
    expect(outcome.actual.decision).toBe('confirm');
    expect(outcome.actual.risk).toBe('L2');
  });

  it('returns block when credit is insufficient', async () => {
    const outcome = await runOfflineSample(
      sample({
        fixtures: {
          customers: [{ ...customer, creditLimit: 100, creditUsed: 0 }],
          products: [product],
          orders: [],
        },
        intent: {
          contract: 'create_order',
          slots: {
            customerId: 'c_weiye',
            items: [{ sku: 'XMAS-BALL-01', quantity: 100, unitPrice: 2 }],
          },
        },
        expect: { decision: 'block', contract: 'create_order' },
      }),
    );
    expect(outcome.actual.decision).toBe('block');
    expect(outcome.actual.reasons.length).toBeGreaterThan(0);
  });

  it('skips multi-turn samples in the offline layer', async () => {
    const outcome = await runOfflineSample(
      sample({ input: { messages: ['第一轮', '第二轮'] } }),
    );
    expect(outcome.skipped).toBe('multi_turn');
  });

  it('skips query tools that have no contract', async () => {
    const outcome = await runOfflineSample(
      sample({
        intent: { contract: 'credit.get', slots: { customerName: '伟业' } },
        expect: { decision: 'allow', contract: 'credit.get' },
      }),
    );
    expect(outcome.skipped).toBe('non_contract');
  });

  it('skips deterministic chat/compound instead of scoring it as a contract decision', async () => {
    const outcome = await runOfflineSample(
      sample({
        input: { messages: ['你好，今天天气怎么样'] },
        intent: undefined,
        expect: { decision: 'clarify' },
      }),
    );
    expect(outcome.intentSource).toBe('deterministic');
    expect(outcome.skipped).toBe('non_contract');
    expect(outcome.actual.decision).toBe('clarify');
    expect(outcome.actual.clarifySlots).toEqual([]);
  });

  it('persists normalized clarify slots from the deterministic parser', async () => {
    const outcome = await runOfflineSample(
      sample({
        input: { messages: ['给伟业公司下一单 100 个圣诞球'] },
        intent: undefined,
        expect: { decision: 'clarify', clarifySlots: ['unitPrice'] },
      }),
    );
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.actual.decision).toBe('clarify');
    expect(outcome.actual.clarifySlots).toEqual(['unitPrice']);
  });

  it('marks unknown operations as errors instead of silently skipping them', async () => {
    const outcome = await runOfflineSample(
      sample({
        intent: { contract: 'foo.bar', slots: {} },
        expect: { decision: 'allow', contract: 'foo.bar' },
      }),
    );
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.actual.decision).toBe('error');
    expect(outcome.actual.code).toBe('UNKNOWN_CONTRACT');
  });

  it('maps contract validation failures to clarify instead of allow', async () => {
    // create_order 的 items 缺失时 normalize 抛错；契约引擎包装为
    // ContractValidationError，离线层必须转为澄清，绝不能当成可执行写入。
    const outcome = await runOfflineSample(
      sample({
        intent: { contract: 'create_order', slots: { customerId: 'c_weiye' } },
        expect: { decision: 'clarify', contract: 'create_order' },
      }),
    );
    expect(outcome.actual.decision).toBe('clarify');
    expect(outcome.actual.code).toBe('INVALID_ARGS');
    expect(outcome.actual.clarifySlots).toEqual([]);
  });
});

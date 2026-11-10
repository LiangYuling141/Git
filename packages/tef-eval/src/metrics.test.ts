import { describe, expect, it } from 'vitest';
import { computeMetrics, percentile } from './metrics';
import type { SampleOutcome } from './outcome';

function outcome(
  id: string,
  expectedDecision: 'allow' | 'confirm' | 'block' | 'clarify',
  actualDecision: 'allow' | 'confirm' | 'block' | 'clarify' | 'error',
  latencyMs = 10,
): SampleOutcome {
  return {
    sampleId: id,
    category: 'normal',
    expected: { decision: expectedDecision },
    actual: {
      decision: actualDecision,
      contract: 'create_order',
      slots: {},
      risk: null,
      clarifySlots: [],
      reasons: [],
    },
    intentSource: 'annotated',
    latencyMs,
  };
}

describe('computeMetrics', () => {
  it('computes strict and safety interception rates separately', () => {
    const metrics = computeMetrics([
      outcome('a', 'block', 'block'),
      outcome('b', 'confirm', 'block'),
      outcome('c', 'block', 'allow'),
      outcome('d', 'allow', 'block'),
    ]);

    expect(metrics.confusion.block.block).toBe(1);
    expect(metrics.confusion.confirm.block).toBe(1);
    expect(metrics.confusion.block.allow).toBe(1);
    expect(metrics.strictInterceptionRate).toBeCloseTo(1 / 3);
    expect(metrics.safetyInterceptionRate).toBeCloseTo(2 / 3);
    expect(metrics.falseRejectionRate).toBe(1);
  });

  it('returns null for empty denominators', () => {
    const metrics = computeMetrics([outcome('a', 'allow', 'allow')]);
    expect(metrics.strictInterceptionRate).toBeNull();
    expect(metrics.safetyInterceptionRate).toBeNull();
    expect(metrics.falseRejectionRate).toBe(0);
    expect(metrics.riskAccuracy).toBeNull();
    expect(metrics.riskExpectedCount).toBe(0);
    expect(metrics.riskObservedCount).toBe(0);
    expect(metrics.riskCoverage).toBeNull();
    expect(metrics.clarifySlotExpectedCount).toBe(0);
    expect(metrics.clarifySlotMatchedCount).toBe(0);
    expect(metrics.clarifySlotRecall).toBeNull();
    expect(metrics.codeAccuracy).toBeNull();
    expect(metrics.codeEvaluatedCount).toBe(0);
    expect(metrics.usageCoveredCount).toBe(0);
    expect(metrics.usageCoverage).toBe(0);
    expect(metrics.costCoveredCount).toBe(0);
    expect(metrics.costCoverage).toBe(0);
  });

  it('scores risk accuracy over every sample with expected risk, counting null as a miss', () => {
    const base = outcome('a', 'allow', 'allow');
    const metrics = computeMetrics([
      {
        ...base,
        expected: { ...base.expected, risk: 'L1' },
        actual: { ...base.actual, risk: 'L1' },
      },
      {
        ...base,
        sampleId: 'b',
        expected: { ...base.expected, risk: 'L2' },
        actual: { ...base.actual, risk: 'L1' },
      },
      // 实际未产生风险判定：仍在分母内，按未命中计算。
      {
        ...base,
        sampleId: 'c',
        expected: { ...base.expected, risk: 'L2' },
        actual: { ...base.actual, risk: null },
      },
      // 未标注期望风险：不计入分母。
      { ...base, sampleId: 'd', actual: { ...base.actual, risk: 'L0' } },
    ]);

    // 3 条标注了期望风险，1 条命中；actual 为 null 的样本不再被排除。
    expect(metrics.riskAccuracy).toBeCloseTo(1 / 3);
    expect(metrics.riskExpectedCount).toBe(3);
    expect(metrics.riskObservedCount).toBe(2);
    expect(metrics.riskCoverage).toBeCloseTo(2 / 3);
  });

  it('scores clarification slot recall against canonical slot names', () => {
    const base = outcome('a', 'clarify', 'clarify');
    const metrics = computeMetrics([
      {
        ...base,
        expected: { decision: 'clarify', clarifySlots: ['customer'] },
        actual: { ...base.actual, clarifySlots: ['customerId'] },
      },
      {
        ...base,
        sampleId: 'b',
        expected: { decision: 'clarify', clarifySlots: ['product', 'order'] },
        actual: { ...base.actual, clarifySlots: ['sku', 'depositRate'] },
      },
    ]);

    expect(metrics.clarificationRecall).toBe(1);
    expect(metrics.clarifySlotExpectedCount).toBe(3);
    expect(metrics.clarifySlotMatchedCount).toBe(2);
    expect(metrics.clarifySlotRecall).toBeCloseTo(2 / 3);
  });

  it('scores code accuracy only where a code is expected', () => {
    const base = outcome('a', 'block', 'block');
    const metrics = computeMetrics([
      {
        ...base,
        expected: { ...base.expected, code: 'PRICE_MISMATCH' },
        actual: { ...base.actual, code: 'PRICE_MISMATCH' },
      },
      {
        ...base,
        sampleId: 'b',
        expected: { ...base.expected, code: 'PRICE_MISMATCH' },
        actual: { ...base.actual, code: 'VALIDATION_ERROR' },
      },
      // 期望有错误码但实际缺失，也算未命中。
      {
        ...base,
        sampleId: 'c',
        expected: { ...base.expected, code: 'PRICE_MISMATCH' },
      },
      // 未标注期望错误码：不计入分母。
      { ...base, sampleId: 'd' },
    ]);

    expect(metrics.codeAccuracy).toBeCloseTo(1 / 3);
    expect(metrics.codeEvaluatedCount).toBe(3);
  });

  it('computes percentile for non-empty values', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 95)).toBeNull();
  });

  it('compares slot values with trimmed strings and key-order-insensitive objects', () => {
    const base = outcome('a', 'allow', 'allow');
    const metrics = computeMetrics([
      {
        ...base,
        expected: {
          ...base.expected,
          slots: { customer: { name: ' 伟业公司 ', tags: ['a'] }, quantity: 100 },
        },
        actual: {
          ...base.actual,
          slots: { customer: { tags: ['a'], name: '伟业公司' }, quantity: ' 100 ' },
        },
      },
    ]);

    // quantity 的 " 100 " 是字符串，不能与数字 100 混同；customer 应命中。
    expect(metrics.slotF1).toBeCloseTo(1 / 2);
  });

  it('computes slot F1 from annotated fields and aggregates usage cost', () => {
    const base = outcome('a', 'allow', 'allow');
    const metrics = computeMetrics([
      {
        ...base,
        expected: { ...base.expected, slots: { quantity: 100, unitPrice: 2 } },
        actual: { ...base.actual, slots: { quantity: 100, unitPrice: 3 } },
        usage: [{ model: 'mock-model', promptTokens: 10, completionTokens: 5, totalTokens: 15 }],
        cost: 0.0001,
      },
    ]);

    expect(metrics.slotF1).toBeCloseTo(0.5);
    expect(metrics.totalTokens).toBe(15);
    expect(metrics.totalCost).toBeCloseTo(0.0001);
    expect(metrics.usageCoveredCount).toBe(1);
    expect(metrics.usageCoverage).toBe(1);
    expect(metrics.costCoveredCount).toBe(1);
    expect(metrics.costCoverage).toBe(1);
  });

  it('reports usage and cost coverage separately from partial totals', () => {
    const base = outcome('a', 'allow', 'allow');
    const metrics = computeMetrics([
      {
        ...base,
        usage: [{ model: 'mock-model', promptTokens: 10, completionTokens: 5, totalTokens: 15 }],
        cost: 0.0001,
      },
      {
        ...base,
        sampleId: 'b',
        usage: [{ model: 'mock-model', promptTokens: 2, completionTokens: 1, totalTokens: 3 }],
        cost: null,
      },
      // 无 usage、无 cost。
      { ...base, sampleId: 'c' },
    ]);

    expect(metrics.totalTokens).toBe(18);
    expect(metrics.usageCoveredCount).toBe(2);
    expect(metrics.usageCoverage).toBeCloseTo(2 / 3);
    expect(metrics.totalCost).toBeCloseTo(0.0001);
    expect(metrics.costCoveredCount).toBe(1);
    expect(metrics.costCoverage).toBeCloseTo(1 / 3);
  });

  it('can disable slot scoring for the e2e layer', () => {
    const base = outcome('a', 'allow', 'allow');
    const metrics = computeMetrics(
      [{ ...base, expected: { ...base.expected, slots: { quantity: 100 } } }],
      { slotScoring: false },
    );
    expect(metrics.slotF1).toBeNull();
  });
});

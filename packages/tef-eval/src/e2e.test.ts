import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@lymtrix/tef-runtime';
import { computeSampleCost, type PricingSnapshot } from './pricing';

const USAGES: TokenUsage[] = [
  { model: 'mock-model', promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
  { model: 'mock-model', promptTokens: 0, completionTokens: 500_000, totalTokens: 500_000 },
];

const PRICING: PricingSnapshot = {
  capturedAt: '2026-11-10T00:00:00.000Z',
  source: 'unit-test',
  model: 'mock-model',
  inputPerMillion: 2,
  outputPerMillion: 8,
};

describe('computeSampleCost', () => {
  it('returns null for non-live modes even when usage exists', () => {
    for (const mode of ['deterministic', 'mock', 'recorded'] as const) {
      expect(computeSampleCost(USAGES, mode)).toBeNull();
    }
  });

  it('returns null for live mode without usage', () => {
    expect(computeSampleCost([], 'live')).toBeNull();
  });

  it('returns null when the default pricing snapshot is unavailable', () => {
    // PRICING_SNAPSHOT 当前为 null（任务 9 填充）；未知价目不得折算成 0。
    expect(computeSampleCost(USAGES, 'live')).toBeNull();
  });

  it('returns null when any usage cannot be priced', () => {
    expect(computeSampleCost(USAGES, 'live', null)).toBeNull();
  });

  it('sums usage costs when pricing is available', () => {
    // 1M input * 2 + 0.5M output * 8 = 2 + 4 = 6
    expect(computeSampleCost(USAGES, 'live', PRICING)).toBe(6);
  });
});

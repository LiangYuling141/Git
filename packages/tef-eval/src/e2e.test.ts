import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@lymtrix/tef-runtime';
import { decisionForTurn } from './e2e';
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

describe('decisionForTurn', () => {
  it('keeps the normal envelope mappings unchanged', () => {
    const base = { taskStatus: 'completed', hasEnvelope: true };
    expect(decisionForTurn({ ...base, envelopeStatus: 'blocked' })).toBe('block');
    expect(decisionForTurn({ ...base, envelopeStatus: 'needs_confirmation' })).toBe('confirm');
    expect(decisionForTurn({ ...base, envelopeStatus: 'ok' })).toBe('allow');
    expect(decisionForTurn({ ...base, envelopeStatus: 'conflict' })).toBe('error');
  });

  it('maps awaiting clarification and idle chat to clarify', () => {
    expect(
      decisionForTurn({ taskStatus: 'awaiting_clarification', hasEnvelope: false }),
    ).toBe('clarify');
    // 聊天回复没有形成可执行操作：与离线层 chat → clarify 一致。
    expect(
      decisionForTurn({
        taskStatus: 'idle',
        hasEnvelope: false,
        reply: '我可以帮您查信用额度。',
      }),
    ).toBe('clarify');
  });

  it('maps missing or unknown product replies to clarify', () => {
    expect(
      decisionForTurn({
        taskStatus: 'failed',
        envelopeStatus: 'failed',
        hasEnvelope: true,
        reply: '库存档案里没有「不存在商品」。',
      }),
    ).toBe('clarify');
    expect(
      decisionForTurn({
        taskStatus: 'failed',
        hasEnvelope: false,
        reply: '没有找到商品，请补充品名。',
      }),
    ).toBe('clarify');
  });

  it('maps tool-visibility rejections to block instead of error', () => {
    // viewer 角色看不到写工具：MCP 协议层拒绝调用，边界已经阻止写入。
    expect(
      decisionForTurn({
        taskStatus: 'failed',
        envelopeStatus: 'error',
        hasEnvelope: true,
        reply: 'MCP error -32602: Tool order.preview_create not found',
      }),
    ).toBe('block');
    expect(
      decisionForTurn({
        taskStatus: 'failed',
        envelopeStatus: 'error',
        hasEnvelope: true,
        reply: 'Tool order.preview_create not visible for this principal',
      }),
    ).toBe('block');
  });

  it('keeps unknown-customer failures as errors', () => {
    expect(
      decisionForTurn({
        taskStatus: 'failed',
        hasEnvelope: false,
        reply: '没有找到客户「停业客户」。请先确认客户名称。',
      }),
    ).toBe('error');
  });
});

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

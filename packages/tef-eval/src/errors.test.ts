import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@lymtrix/tef-runtime';
import { EvalRunError, errorOutcome } from './errors';
import type { EvalSample } from './sample';

const USAGE: TokenUsage = {
  model: 'deepseek-flash',
  promptTokens: 1000,
  completionTokens: 500,
  totalTokens: 1500,
};

const SAMPLE: EvalSample = {
  id: 'normal_l1_order',
  category: 'normal',
  tenant: { thresholds: { amountL2Threshold: 5000 } },
  principal: { userId: 'u_eval', role: 'owner' },
  input: { messages: ['给伟业公司下一单 100 个圣诞球，单价 2 块'] },
  fixtures: { customers: [], products: [], orders: [] },
  expect: { decision: 'allow' },
  tags: [],
};

describe('EvalRunError', () => {
  it('carries the usage and cost collected before the failure', () => {
    const error = new EvalRunError('model fell back to deterministic', [USAGE], 0.00042);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EvalRunError');
    expect(error.message).toBe('model fell back to deterministic');
    expect(error.usage).toEqual([USAGE]);
    expect(error.cost).toBe(0.00042);
  });
});

describe('errorOutcome', () => {
  it('keeps usage and cost from an EvalRunError', () => {
    const outcome = errorOutcome(
      SAMPLE,
      new EvalRunError('fell back', [USAGE], 0.00042),
      performance.now(),
    );
    expect(outcome.actual.decision).toBe('error');
    expect(outcome.actual.code).toBe('EVAL_RUN_ERROR');
    expect(outcome.actual.reasons).toEqual(['fell back']);
    expect(outcome.usage).toEqual([USAGE]);
    expect(outcome.cost).toBe(0.00042);
    expect(outcome.traceId).toBe('tr_eval_normal_l1_order_error');
  });

  it('preserves a zero cost instead of turning it into null', () => {
    const outcome = errorOutcome(SAMPLE, new EvalRunError('fell back', [], 0), 0);
    expect(outcome.usage).toBeUndefined();
    expect(outcome.cost).toBe(0);
  });

  it('keeps empty usage and null cost for non-EvalRunError failures', () => {
    const outcome = errorOutcome(SAMPLE, new Error('boom'), 0);
    expect(outcome.actual.code).toBe('EVAL_RUN_ERROR');
    expect(outcome.actual.reasons).toEqual(['boom']);
    expect(outcome.usage).toBeUndefined();
    expect(outcome.cost).toBeNull();
  });
});

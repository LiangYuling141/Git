import { describe, expect, it } from 'vitest';
import type { SampleOutcome } from './outcome';
import { estimateCost } from './pricing';
import { renderJson, renderMarkdown, type EvalRun } from './report';

const OUTCOMES: SampleOutcome[] = [
  {
    sampleId: 'normal_l1_order',
    category: 'normal',
    expected: { decision: 'allow' },
    actual: {
      decision: 'allow',
      contract: 'create_order',
      slots: {},
      risk: null,
      clarifySlots: [],
      reasons: [],
    },
    intentSource: 'annotated',
    latencyMs: 1.5,
    traceId: 'tr_eval_normal_l1_order',
  },
  {
    sampleId: 'legacy_sample',
    category: 'normal',
    expected: { decision: 'allow' },
    actual: {
      decision: 'allow',
      contract: 'create_order',
      slots: {},
      risk: null,
      clarifySlots: [],
      reasons: [],
    },
    intentSource: 'annotated',
    latencyMs: 1,
  },
];

const run: EvalRun = {
  schemaVersion: 1,
  runId: 'eval_test',
  startedAt: '2026-11-10T00:00:00.000Z',
  mode: 'deterministic',
  layer: 'offline',
  model: { name: 'deterministic', provider: 'none' },
  sampleCount: 2,
  metrics: {
    sampleCount: 2,
    evaluatedCount: 1,
    skippedCount: 0,
    confusion: {},
    strictInterceptionRate: null,
    safetyInterceptionRate: null,
    falseRejectionRate: 0,
    clarificationRecall: null,
    clarifySlotExpectedCount: 0,
    clarifySlotMatchedCount: 0,
    clarifySlotRecall: null,
    contractAccuracy: 1,
    riskAccuracy: null,
    riskExpectedCount: 0,
    riskObservedCount: 0,
    riskCoverage: null,
    codeAccuracy: null,
    codeEvaluatedCount: 0,
    slotF1: null,
    latencyP50: 1,
    latencyP95: 1,
    totalTokens: null,
    usageCoveredCount: 0,
    usageCoverage: 0,
    totalCost: null,
    costCoveredCount: 0,
    costCoverage: 0,
  },
  samples: OUTCOMES,
  notes: [],
};

describe('pricing and report', () => {
  it('returns null when usage is missing', () => {
    expect(estimateCost(undefined)).toBeNull();
  });

  it('returns null when pricing is missing', () => {
    expect(
      estimateCost({ model: 'mock-model', promptTokens: 10, completionTokens: 5, totalTokens: 15 }, null),
    ).toBeNull();
  });

  it('renders json and markdown with the run identity and traceId', () => {
    const parsed = JSON.parse(renderJson(run));
    expect(parsed.runId).toBe('eval_test');
    expect(parsed.samples[0].traceId).toBe('tr_eval_normal_l1_order');
    const markdown = renderMarkdown(run);
    expect(markdown).toContain('eval_test');
    expect(markdown).toContain('deterministic');
    expect(markdown).toContain('样本规模');
    expect(markdown).toContain(
      '| 样本 | 类别 | 状态 | 期望 | 实际 | 延迟 | traceId | 原因 |',
    );
    expect(markdown).toContain(
      '| normal_l1_order | normal | evaluated | allow | allow | 1.5 ms | tr_eval_normal_l1_order |  |',
    );
    // 无 traceId 的样本输出占位符，不伪造 trace。
    expect(markdown).toContain('| legacy_sample | normal | evaluated | allow | allow | 1.0 ms | - |  |');
  });

  it('shows null instead of fabricating missing rates and coverage', () => {
    const markdown = renderMarkdown(run);
    expect(markdown).toContain('| 严格拦截率 | null |');
    expect(markdown).toContain('| 安全拦截率 | null |');
    expect(markdown).toContain(
      '| 风险等级准确率 | null（期望 0 条 / 观测 0 条 / 覆盖 null） |',
    );
    expect(markdown).toContain('| 澄清槽位召回率 | null（0/0 槽位） |');
    expect(markdown).toContain('| 错误码准确率 | null（0 条） |');
    expect(markdown).toContain('| 总 token | null（覆盖 0/1 条） |');
    expect(markdown).toContain('| 总成本 | null（覆盖 0/1 条） |');
    expect(markdown).toContain('不具统计显著性');
  });

  it('renders requested sample count for a skipped layer', () => {
    const markdown = renderMarkdown({ ...run, sampleCount: 0, requestedSampleCount: 24 });
    expect(markdown).toContain('- 样本数：0（请求 24 条，跳过 24 条）');
  });

  it('marks skipped rows with their reason instead of reporting an error decision', () => {
    const skipped: SampleOutcome = {
      sampleId: 'query_sample',
      category: 'normal',
      expected: { decision: 'allow' },
      actual: {
        decision: 'error',
        contract: 'credit.get',
        slots: {},
        risk: null,
        clarifySlots: [],
        reasons: ['credit.get is a query tool, not a contract'],
      },
      intentSource: 'annotated',
      skipped: 'non_contract',
      latencyMs: 0.5,
      traceId: 'tr_eval_query_sample',
    };
    const markdown = renderMarkdown({ ...run, samples: [skipped] });
    expect(markdown).toContain(
      '| query_sample | normal | skipped: non_contract | allow | - | 0.5 ms | tr_eval_query_sample |',
    );
  });

  it('escapes pipes and newlines in markdown table cells', () => {
    const malicious: SampleOutcome = {
      ...OUTCOMES[0],
      sampleId: 'evil|id',
      actual: { ...OUTCOMES[0].actual, reasons: ['bad | reason\nsecond line'] },
    };
    const markdown = renderMarkdown({ ...run, samples: [malicious] });
    expect(markdown).toContain('| evil\\|id |');
    expect(markdown).toContain('bad \\| reason\\nsecond line');
    // 转义后表格仍保持 8 列，注入内容没有拆行。
    const row = markdown
      .split('\n')
      .find((line) => line.startsWith('| evil\\|id |'));
    expect(row?.split(/(?<!\\)\|/)).toHaveLength(10);
  });
});

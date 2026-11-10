import type { EvalMetrics } from './metrics';
import type { SampleOutcome } from './outcome';

export type EvalMode = 'deterministic' | 'mock' | 'recorded' | 'live';

export interface EvalRun {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  mode: EvalMode;
  layer: 'offline' | 'e2e';
  model: { name: string; provider: string };
  sampleCount: number;
  /** 本次请求的样本数；被跳过的层 sampleCount 为 0，用该字段保留请求规模。 */
  requestedSampleCount?: number;
  metrics: EvalMetrics;
  samples: SampleOutcome[];
  notes: string[];
}

export function renderJson(run: EvalRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

function rate(value: number | null): string {
  return value === null ? 'null' : `${(value * 100).toFixed(1)}%`;
}

/** Markdown 表格单元格转义：管道符与换行都不能破坏表格结构。 */
function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '\\n');
}

/** 从混淆矩阵推导期望澄清的样本数，避免报告与指标重复维护字段。 */
function expectedClarifyCount(metrics: EvalMetrics): number {
  return Object.values(metrics.confusion.clarify ?? {}).reduce((sum, value) => sum + value, 0);
}

export function renderMarkdown(run: EvalRun): string {
  const lines = [
    `# 评测报告 ${run.runId}`,
    '',
    `- 开始时间：${run.startedAt}`,
    `- 模式：${run.mode}`,
    `- 层级：${run.layer}`,
    `- 模型：${run.model.provider}/${run.model.name}`,
    run.requestedSampleCount !== undefined &&
    run.requestedSampleCount !== run.sampleCount
      ? `- 样本数：${run.sampleCount}（请求 ${run.requestedSampleCount} 条，跳过 ${run.requestedSampleCount - run.sampleCount} 条）`
      : `- 样本数：${run.sampleCount}`,
    '',
    '## 指标',
    '',
    '| 指标 | 值 |',
    '|------|----|',
    `| 严格拦截率 | ${rate(run.metrics.strictInterceptionRate)} |`,
    `| 安全拦截率 | ${rate(run.metrics.safetyInterceptionRate)} |`,
    `| 误拒率 | ${rate(run.metrics.falseRejectionRate)} |`,
    `| 澄清召回率 | ${rate(run.metrics.clarificationRecall)}（${expectedClarifyCount(run.metrics)} 条） |`,
    `| 澄清槽位召回率 | ${rate(run.metrics.clarifySlotRecall)}（${run.metrics.clarifySlotMatchedCount}/${run.metrics.clarifySlotExpectedCount} 槽位） |`,
    `| 意图准确率 | ${rate(run.metrics.contractAccuracy)} |`,
    `| 风险等级准确率 | ${rate(run.metrics.riskAccuracy)}（期望 ${run.metrics.riskExpectedCount} 条 / 观测 ${run.metrics.riskObservedCount} 条 / 覆盖 ${rate(run.metrics.riskCoverage)}） |`,
    `| 错误码准确率 | ${rate(run.metrics.codeAccuracy)}（${run.metrics.codeEvaluatedCount} 条） |`,
    `| 槽位 F1 | ${run.metrics.slotF1 === null ? 'null' : run.metrics.slotF1.toFixed(3)} |`,
    `| P50 延迟 | ${run.metrics.latencyP50 === null ? 'null' : `${run.metrics.latencyP50.toFixed(1)} ms`} |`,
    `| P95 延迟 | ${run.metrics.latencyP95 === null ? 'null' : `${run.metrics.latencyP95.toFixed(1)} ms`} |`,
    `| 总 token | ${run.metrics.totalTokens ?? 'null'}（覆盖 ${run.metrics.usageCoveredCount}/${run.metrics.evaluatedCount} 条） |`,
    `| 总成本 | ${run.metrics.totalCost === null ? 'null' : run.metrics.totalCost.toFixed(6)}（覆盖 ${run.metrics.costCoveredCount}/${run.metrics.evaluatedCount} 条） |`,
    '',
    '> 样本规模说明：本报告基于种子样本，P95 与比例指标不具统计显著性，仅作工程趋势参考。',
    '',
    '## 样本明细',
    '',
    '| 样本 | 类别 | 状态 | 期望 | 实际 | 延迟 | traceId | 原因 |',
    '|------|------|------|------|------|------|---------|------|',
    ...run.samples.map((sample) => {
      const status = sample.skipped ? `skipped: ${sample.skipped}` : 'evaluated';
      // 跳过样本不计分，实际决策列输出占位符，避免把跳过误读成 error 决策。
      const actualDecision = sample.skipped ? '-' : sample.actual.decision;
      return `| ${cell(sample.sampleId)} | ${cell(sample.category)} | ${cell(status)} | ${cell(sample.expected.decision)} | ${cell(actualDecision)} | ${sample.latencyMs.toFixed(1)} ms | ${cell(sample.traceId ?? '-')} | ${cell(sample.actual.reasons.join('; '))} |`;
    }),
    '',
  ];
  if (run.notes.length > 0) {
    lines.push('## 说明', '', ...run.notes.map((note) => `- ${note}`), '');
  }
  return lines.join('\n');
}

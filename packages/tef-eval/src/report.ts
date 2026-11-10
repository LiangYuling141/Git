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

export function renderMarkdown(run: EvalRun): string {
  const lines = [
    `# 评测报告 ${run.runId}`,
    '',
    `- 开始时间：${run.startedAt}`,
    `- 模式：${run.mode}`,
    `- 层级：${run.layer}`,
    `- 模型：${run.model.provider}/${run.model.name}`,
    `- 样本数：${run.sampleCount}`,
    '',
    '## 指标',
    '',
    '| 指标 | 值 |',
    '|------|----|',
    `| 严格拦截率 | ${rate(run.metrics.strictInterceptionRate)} |`,
    `| 安全拦截率 | ${rate(run.metrics.safetyInterceptionRate)} |`,
    `| 误拒率 | ${rate(run.metrics.falseRejectionRate)} |`,
    `| 澄清召回率 | ${rate(run.metrics.clarificationRecall)} |`,
    `| 意图准确率 | ${rate(run.metrics.contractAccuracy)} |`,
    `| 风险等级准确率 | ${rate(run.metrics.riskAccuracy)} |`,
    `| 错误码准确率 | ${rate(run.metrics.codeAccuracy)} |`,
    `| 槽位 F1 | ${run.metrics.slotF1 === null ? 'null' : run.metrics.slotF1.toFixed(3)} |`,
    `| P50 延迟 | ${run.metrics.latencyP50 === null ? 'null' : `${run.metrics.latencyP50.toFixed(1)} ms`} |`,
    `| P95 延迟 | ${run.metrics.latencyP95 === null ? 'null' : `${run.metrics.latencyP95.toFixed(1)} ms`} |`,
    `| 总 token | ${run.metrics.totalTokens ?? 'null'} |`,
    `| 总成本 | ${run.metrics.totalCost === null ? 'null' : run.metrics.totalCost.toFixed(6)} |`,
    '',
    '> 样本规模说明：本报告基于种子样本，P95 与比例指标不具统计显著性，仅作工程趋势参考。',
    '',
    '## 样本明细',
    '',
    '| 样本 | 类别 | 期望 | 实际 | 延迟 |',
    '|------|------|------|------|------|',
    ...run.samples.map(
      (sample) =>
        `| ${sample.sampleId} | ${sample.category} | ${sample.expected.decision} | ${sample.actual.decision} | ${sample.latencyMs.toFixed(1)} ms |`,
    ),
    '',
  ];
  if (run.notes.length > 0) {
    lines.push('## 说明', '', ...run.notes.map((note) => `- ${note}`), '');
  }
  return lines.join('\n');
}

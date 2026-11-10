import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { prisma } from '@/lib/prisma';
import { parseEvalOptions } from './cli-options';
import { loadSamplesForCli } from './load';
import { resolveExitCode } from './exit-code';
import type { EvalSample } from './sample';
import { runOfflineSample } from './offline';
import { runE2eSample } from './e2e';
import { computeMetrics } from './metrics';
import { renderJson, renderMarkdown, type EvalMode, type EvalRun } from './report';
import type { SampleOutcome } from './outcome';

dotenv.config({ path: '.env', quiet: true });

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * 退出码约定由 `resolveExitCode` 统一裁定：
 * 0 正常完成（含测得的 error 决策）；1 样本执行抛错/配置或 harness 失败；
 * 2 样本集加载/校验失败。
 */
function loadSamplesOrExit(dir: string): EvalSample[] | null {
  const result = loadSamplesForCli(dir);
  if (result.kind === 'error') {
    console.error(result.message);
    process.exitCode = resolveExitCode({ loadFailed: true, thrownSampleError: false });
    return null;
  }
  return result.samples;
}

function runId(): string {
  return `eval_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** 单样本错误隔离：一条样本失败只记录 error outcome，不中止整批评测。 */
function errorOutcome(sample: EvalSample, error: unknown, started: number): SampleOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    sampleId: sample.id,
    category: sample.category,
    expected: sample.expect,
    actual: {
      decision: 'error',
      contract: null,
      slots: {},
      risk: null,
      clarifySlots: [],
      code: 'EVAL_RUN_ERROR',
      reasons: [message],
    },
    intentSource: 'none',
    latencyMs: performance.now() - started,
    // 执行异常时没有真实决策链，仍给出确定性 traceId，保证报告
    // “每条样本都有 traceId”的陈述对 error outcome 同样成立。
    traceId: `tr_eval_${sample.id}_error`,
  };
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseEvalOptions(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { layerMode, evalMode } = options;

  if (evalMode === 'live') {
    if (process.env.TEF_MODEL_TESTS !== '1') {
      fail('--live requires TEF_MODEL_TESTS=1');
    }
    if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.length < 20) {
      fail('--live requires a usable DEEPSEEK_API_KEY');
    }
  }

  const samples = loadSamplesOrExit(options.samples);
  if (!samples) return;

  const id = runId();
  // 运行开始时间只采集一次，不随各层结束时间漂移。
  const startedAt = new Date().toISOString();
  const outDir = options.out ?? join('eval-results', id);
  mkdirSync(outDir, { recursive: true });

  const requested: Array<'offline' | 'e2e'> =
    layerMode === 'all' ? ['offline', 'e2e'] : [layerMode as 'offline' | 'e2e'];
  // 样本级异常被隔离记录后批次继续跑完；但发生执行抛错时整批以退出码 1 结束。
  let thrownSampleError = false;
  // e2e 被显式请求却因数据库缺失跳过时，必须非零退出（除非 --allow-missing-db）。
  let e2eSkipped = false;
  const allOutcomes: SampleOutcome[] = [];

  for (const layer of requested) {
    const outcomes: SampleOutcome[] = [];
    const notes: string[] = [];

    if (layer === 'offline') {
      for (const sample of samples) {
        if (options.verbose) console.log(`[offline] ${sample.id}`);
        const started = performance.now();
        try {
          outcomes.push(await runOfflineSample(sample));
        } catch (error) {
          thrownSampleError = true;
          outcomes.push(errorOutcome(sample, error, started));
        }
      }
    } else {
      const hasDb = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
      if (!hasDb) {
        e2eSkipped = true;
        const skippedNotes = [
          `skipped: DATABASE_URL/TEF_DB_TESTS not configured; e2e layer did not run (requested ${samples.length} samples)`,
        ];
        const skippedRun = buildRun(id, startedAt, evalMode, 'e2e', samples, [], skippedNotes);
        mkdirSync(join(outDir, 'e2e'), { recursive: true });
        writeFileSync(join(outDir, 'e2e', 'results.json'), renderJson(skippedRun));
        console.warn(skippedNotes[0]);
        continue;
      }
      for (const sample of samples) {
        if (options.verbose) console.log(`[e2e] ${sample.id}`);
        const modelDir = evalMode === 'live' ? join(outDir, 'recordings') : options.recorded;
        const started = performance.now();
        try {
          outcomes.push(await runE2eSample(sample, evalMode, modelDir));
        } catch (error) {
          thrownSampleError = true;
          outcomes.push(errorOutcome(sample, error, started));
        }
      }
      notes.push('端到端层使用 fixture 业务证据，不等价于生产业务网关。');
    }

    notes.push('种子样本规模不足以支持统计显著性，比例指标与 P95 仅作工程趋势参考。');
    const run = buildRun(id, startedAt, evalMode, layer, samples, outcomes, notes);
    const layerDir = join(outDir, layer);
    mkdirSync(layerDir, { recursive: true });
    writeFileSync(join(layerDir, 'results.json'), renderJson(run));
    writeFileSync(join(layerDir, 'report.md'), renderMarkdown(run));
    allOutcomes.push(...outcomes);
  }

  console.log(`eval results written to ${outDir}`);
  // 治理数据按租户前缀隔离；traceId 让报告读者能从审计表定位每条决策链。
  console.log('eval tenant prefix: t_eval_');
  const traceIds = allOutcomes.flatMap((outcome) =>
    outcome.traceIds ?? (outcome.traceId ? [outcome.traceId] : []),
  );
  console.log(`eval traceIds (${traceIds.length}):`);
  for (const traceId of traceIds) console.log(`  ${traceId}`);
  process.exitCode = resolveExitCode({
    loadFailed: false,
    thrownSampleError,
    e2eSkipped,
    allowMissingDb: options.allowMissingDb,
  });
}

/**
 * 报告中的模型名来自实际观测到的 usage，而不是 CLI 的请求假设。
 * 修改 DEEPSEEK_MODEL 后仍能如实标注；没有 usage 记为 unknown，
 * 多个模型（或别名漂移）记为 mixed。
 */
function reportModel(
  evalMode: EvalMode,
  outcomes: SampleOutcome[],
): { name: string; provider: string } {
  if (evalMode !== 'live') return { name: evalMode, provider: 'none' };
  const models = new Set(
    outcomes.flatMap((outcome) => (outcome.usage ?? []).map((usage) => usage.model)),
  );
  const name = models.size === 0 ? 'unknown' : models.size === 1 ? [...models][0] : 'mixed';
  return { name, provider: 'deepseek' };
}

function buildRun(
  id: string,
  startedAt: string,
  evalMode: EvalMode,
  layer: 'offline' | 'e2e',
  requestedSamples: EvalSample[],
  outcomes: SampleOutcome[],
  notes: string[],
): EvalRun {
  return {
    schemaVersion: 1,
    runId: id,
    startedAt,
    mode: evalMode,
    layer,
    model: reportModel(evalMode, outcomes),
    // sampleCount 表示实际产出的 outcome 数；被跳过的层为 0，
    // 请求规模由 requestedSampleCount 单独记录，避免“24 条样本 0 条指标”的误读。
    sampleCount: outcomes.length,
    requestedSampleCount: requestedSamples.length,
    metrics: computeMetrics(outcomes, { slotScoring: layer === 'offline' }),
    samples: outcomes,
    notes,
  };
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

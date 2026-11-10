import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { prisma } from '@/lib/prisma';
import { loadSamplesForCli } from './load';
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
 * 退出码约定：0 正常完成；1 配置/执行错误（参数非法、--live 前置条件缺失、
 * 未捕获的 harness 异常）；2 样本集加载/校验失败（目录不可读、JSON 解析、
 * zod 校验、重复 id、空样本集）。
 *
 * 样本级执行抛错会被 errorOutcome 记录为评测数据，批次继续跑完且退出码为 0；
 * 只有 harness 自身失败才映射为 1。
 */
function loadSamplesOrExit(dir: string): EvalSample[] | null {
  const result = loadSamplesForCli(dir);
  if (result.kind === 'error') {
    console.error(result.message);
    process.exitCode = 2;
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
      code: 'EVAL_RUN_ERROR',
      reasons: [message],
    },
    intentSource: 'none',
    latencyMs: performance.now() - started,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'all' },
      samples: { type: 'string', default: 'packages/tef-eval/samples' },
      out: { type: 'string' },
      live: { type: 'boolean', default: false },
      recorded: { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
  });

  const layerMode = values.mode;
  if (!['offline', 'e2e', 'all'].includes(layerMode)) {
    fail(`invalid --mode: ${layerMode} (expected offline|e2e|all)`);
  }
  if (values.live && values.recorded) {
    fail('--live and --recorded are mutually exclusive');
  }

  const evalMode: EvalMode = values.live
    ? 'live'
    : values.recorded
      ? 'recorded'
      : 'deterministic';
  if (evalMode === 'live') {
    if (process.env.TEF_MODEL_TESTS !== '1') {
      fail('--live requires TEF_MODEL_TESTS=1');
    }
    if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.length < 20) {
      fail('--live requires a usable DEEPSEEK_API_KEY');
    }
  }

  const samples = loadSamplesOrExit(values.samples);
  if (!samples) return;

  const id = runId();
  // 运行开始时间只采集一次，不随各层结束时间漂移。
  const startedAt = new Date().toISOString();
  const outDir = values.out ?? join('eval-results', id);
  mkdirSync(outDir, { recursive: true });

  const requested: Array<'offline' | 'e2e'> =
    layerMode === 'all' ? ['offline', 'e2e'] : [layerMode as 'offline' | 'e2e'];

  for (const layer of requested) {
    const outcomes: SampleOutcome[] = [];
    const notes: string[] = [];

    if (layer === 'offline') {
      for (const sample of samples) {
        if (values.verbose) console.log(`[offline] ${sample.id}`);
        const started = performance.now();
        try {
          outcomes.push(await runOfflineSample(sample));
        } catch (error) {
          outcomes.push(errorOutcome(sample, error, started));
        }
      }
    } else {
      const hasDb = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
      if (!hasDb) {
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
        if (values.verbose) console.log(`[e2e] ${sample.id}`);
        const modelDir = evalMode === 'live' ? join(outDir, 'recordings') : values.recorded;
        const started = performance.now();
        try {
          outcomes.push(await runE2eSample(sample, evalMode, modelDir));
        } catch (error) {
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
  }

  console.log(`eval results written to ${outDir}`);
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
    model: {
      name: evalMode === 'live' ? 'deepseek-chat' : evalMode,
      provider: evalMode === 'live' ? 'deepseek' : 'none',
    },
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

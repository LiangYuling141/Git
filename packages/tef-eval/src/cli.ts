import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { prisma } from '@/lib/prisma';
import { loadSamples, type EvalSample } from './sample';
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

  const samples = loadSamples(values.samples);
  if (samples.length === 0) fail(`no samples found in ${values.samples}`);

  const id = runId();
  const outDir = values.out ?? join('eval-results', id);
  mkdirSync(outDir, { recursive: true });

  const requested: Array<'offline' | 'e2e'> =
    layerMode === 'all' ? ['offline', 'e2e'] : [layerMode as 'offline' | 'e2e'];
  let hadSampleError = false;

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
          'skipped: DATABASE_URL/TEF_DB_TESTS not configured; e2e layer did not run',
        ];
        const skippedRun = buildRun(id, evalMode, 'e2e', samples, [], skippedNotes);
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
    if (outcomes.some((outcome) => outcome.actual.decision === 'error' && !outcome.skipped)) {
      hadSampleError = true;
    }
    const run = buildRun(id, evalMode, layer, samples, outcomes, notes);
    const layerDir = join(outDir, layer);
    mkdirSync(layerDir, { recursive: true });
    writeFileSync(join(layerDir, 'results.json'), renderJson(run));
    writeFileSync(join(layerDir, 'report.md'), renderMarkdown(run));
  }

  console.log(`eval results written to ${outDir}`);
  // 退出码约定：0 全部完成；1 批次级失败（参数/配置/未捕获异常）；
  // 2 批次完成但存在样本级错误（errorOutcome），报告仍已落盘。
  if (hadSampleError) process.exitCode = 2;
}

function buildRun(
  id: string,
  evalMode: EvalMode,
  layer: 'offline' | 'e2e',
  samples: EvalSample[],
  outcomes: SampleOutcome[],
  notes: string[],
): EvalRun {
  return {
    schemaVersion: 1,
    runId: id,
    startedAt: new Date().toISOString(),
    mode: evalMode,
    layer,
    model: {
      name: evalMode === 'live' ? 'deepseek-chat' : evalMode,
      provider: evalMode === 'live' ? 'deepseek' : 'none',
    },
    sampleCount: samples.length,
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

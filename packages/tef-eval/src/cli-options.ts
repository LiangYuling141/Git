import { parseArgs } from 'node:util';
import type { EvalMode } from './report';

export type EvalLayerMode = 'offline' | 'e2e' | 'all';

export interface EvalCliOptions {
  layerMode: EvalLayerMode;
  samples: string;
  out?: string;
  live: boolean;
  recorded?: string;
  verbose: boolean;
  /** 端到端层因数据库缺失跳过时是否允许退出码 0。 */
  allowMissingDb: boolean;
  evalMode: EvalMode;
}

/**
 * CLI 参数解析与模式裁定（纯函数，便于单测）。
 *
 * 参数非法时抛出 Error，由 CLI 入口收敛为退出码 1；
 * `parseArgs` 自身的未知参数错误也原样抛出。
 */
export function parseEvalOptions(args: string[]): EvalCliOptions {
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: 'string', default: 'all' },
      samples: { type: 'string', default: 'packages/tef-eval/samples' },
      out: { type: 'string' },
      live: { type: 'boolean', default: false },
      recorded: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      'allow-missing-db': { type: 'boolean', default: false },
    },
  });

  const layerMode = values.mode;
  if (layerMode !== 'offline' && layerMode !== 'e2e' && layerMode !== 'all') {
    throw new Error(`invalid --mode: ${layerMode} (expected offline|e2e|all)`);
  }
  if (values.live && values.recorded) {
    throw new Error('--live and --recorded are mutually exclusive');
  }

  const evalMode: EvalMode = values.live
    ? 'live'
    : values.recorded
      ? 'recorded'
      : 'deterministic';

  return {
    layerMode,
    samples: values.samples,
    out: values.out,
    live: values.live,
    recorded: values.recorded,
    verbose: values.verbose,
    allowMissingDb: values['allow-missing-db'],
    evalMode,
  };
}

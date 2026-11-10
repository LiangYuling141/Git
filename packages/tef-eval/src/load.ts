import { loadSamples, type EvalSample } from './sample';

// 用字符串判别符而不是 boolean：本项目 tsconfig 关闭了 strictNullChecks，
// 非严格模式下 TS 不会按 boolean 字面量收窄联合类型。
export type SampleLoadResult =
  | { kind: 'ok'; samples: EvalSample[] }
  | { kind: 'error'; message: string };

/**
 * CLI 的样本集加载入口。
 *
 * 所有加载/校验失败（目录不可读、JSON 解析、zod 校验、重复 id、空样本集）
 * 都收敛为 `kind: 'error'`，由 CLI 统一映射到退出码 2；不在加载层直接退出，
 * 便于单元测试覆盖而不需要 mock `process.exit`。
 */
export function loadSamplesForCli(dir: string): SampleLoadResult {
  let samples: EvalSample[];
  try {
    samples = loadSamples(dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `failed to load samples from ${dir}: ${message}` };
  }
  if (samples.length === 0) {
    return { kind: 'error', message: `no samples found in ${dir}` };
  }
  return { kind: 'ok', samples };
}

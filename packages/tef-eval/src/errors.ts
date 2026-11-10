import type { TokenUsage } from '@lymtrix/tef-runtime';
import type { EvalSample } from './sample';
import type { SampleOutcome } from './outcome';

/**
 * 评测执行期异常：附带抛出前已经产生的模型用量与成本。
 *
 * 单样本异常会被 CLI 隔离为 `errorOutcome` 并继续跑完整批；如果异常对象不携带
 * usage，报告会把已经真实发生的模型调用记成“无用量”，低估 token 与成本。
 * 该类型只用于 harness 主动抛出的失败（例如非确定性模式静默回落）。
 */
export class EvalRunError extends Error {
  readonly usage: TokenUsage[];
  readonly cost: number | null;

  constructor(message: string, usage: TokenUsage[], cost: number | null) {
    super(message);
    this.name = 'EvalRunError';
    this.usage = usage;
    this.cost = cost;
  }
}

/**
 * 单样本错误隔离：一条样本失败只记录 error outcome，不中止整批评测。
 *
 * 非 `EvalRunError` 的异常没有可靠的用量来源，保持空 usage 与 `cost: null`，
 * 不用 0 掩盖未知成本。
 */
export function errorOutcome(sample: EvalSample, error: unknown, started: number): SampleOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const evalError = error instanceof EvalRunError ? error : null;
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
    ...(evalError !== null && evalError.usage.length > 0 ? { usage: evalError.usage } : {}),
    cost: evalError?.cost ?? null,
  };
}

import type { Check, ErrorCode } from './types';

/**
 * TEF 内部错误。所有抛出点都带 §6.3 的稳定错误码，
 * 工具层据此映射成统一返回信封，Agent 据此决定重试还是重新预览。
 */
export class TefError extends Error {
  readonly code: ErrorCode;
  readonly checks: Check[];

  constructor(code: ErrorCode, message: string, checks: Check[] = []) {
    super(message);
    this.name = 'TefError';
    this.code = code;
    this.checks = checks;
  }
}

export function isTefError(error: unknown): error is TefError {
  return error instanceof TefError;
}

/**
 * 执行器在“副作用可能已经提交，但响应丢失/超时”时抛出。
 *
 * 状态机必须把这次尝试标记为 UNKNOWN 并交给对账按同一幂等键收敛，
 * 不能把它当成确定失败：后者允许调用方用新幂等键重试，可能重复产生副作用。
 * 进程内执行器不会抛这个错误——它的 INTERNAL 表示事务已回滚，属于确定失败。
 */
export class EffectsExecutionUnknownError extends Error {
  constructor(message = 'effects execution outcome is unknown; reconciliation required') {
    super(message);
    this.name = 'EffectsExecutionUnknownError';
  }
}

/** RiskOutcome 在代码里是 'Block'，在数据库枚举里是 'BLOCK'。 */
export function riskToDb(risk: 'L0' | 'L1' | 'L2' | 'Block'): 'L0' | 'L1' | 'L2' | 'BLOCK' {
  return risk === 'Block' ? 'BLOCK' : risk;
}

export function riskFromDb(risk: 'L0' | 'L1' | 'L2' | 'BLOCK'): 'L0' | 'L1' | 'L2' | 'Block' {
  return risk === 'BLOCK' ? 'Block' : risk;
}

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

/** RiskOutcome 在代码里是 'Block'，在数据库枚举里是 'BLOCK'。 */
export function riskToDb(risk: 'L0' | 'L1' | 'L2' | 'Block'): 'L0' | 'L1' | 'L2' | 'BLOCK' {
  return risk === 'Block' ? 'BLOCK' : risk;
}

export function riskFromDb(risk: 'L0' | 'L1' | 'L2' | 'BLOCK'): 'L0' | 'L1' | 'L2' | 'Block' {
  return risk === 'BLOCK' ? 'Block' : risk;
}

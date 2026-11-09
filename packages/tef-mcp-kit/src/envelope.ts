import type { Check, DiffEntry, Envelope, EnvelopeStatus, ErrorCode, RiskOutcome, ToolError } from '@lymtrix/tef-core';
import { ContractValidationError, TefError, isTefError } from '@lymtrix/tef-core';

/**
 * §6.2 统一返回信封 与 §6.3 稳定错误码。
 *
 * blocked / conflict / needs_confirmation 都是"确定性判定结果"，不是工具故障，
 * 所以 isError 只在 status === 'error' 时为真。Agent 需要按错误码决定
 * 是重试、退避、还是重新预览——把它们标成工具错误会让 Agent 无法区分。
 */

export function ok<T extends Record<string, unknown>>(data: T, extra: Partial<Envelope<T>> = {}): Envelope<T> {
  return { status: 'ok', data, ...extra };
}

export function needsConfirmation(extra: Omit<Partial<Envelope>, 'status'>): Envelope {
  return { status: 'needs_confirmation', ...extra };
}

export function blocked(reasons: string[], extra: Omit<Partial<Envelope>, 'status' | 'reasons'> = {}): Envelope {
  return { status: 'blocked', risk: 'Block', reasons, ...extra };
}

export function conflict(message: string, extra: Omit<Partial<Envelope>, 'status'> = {}): Envelope {
  return { status: 'conflict', error: { code: 'CONFLICT', message }, ...extra };
}

export function fail(code: ErrorCode, message: string, checks: Check[] = []): Envelope {
  const error: ToolError = { code, message };
  if (checks.length > 0) error.checks = checks;
  return { status: 'error', error };
}

export function failedChecksToError(checks: Check[]): ToolError & { code: ErrorCode } {
  const blocking = checks.filter((check) => !check.ok && (check.severity ?? 'block') === 'block');
  const first = blocking[0];
  const code: ErrorCode =
    first?.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : first?.code === 'PERMISSION_DENIED'
        ? 'PERMISSION_DENIED'
        : 'VALIDATION_ERROR';
  return {
    code,
    message: blocking.map((check) => `${check.code}: ${check.message}`).join('; ') || 'blocked by contract checks',
    checks: blocking,
  };
}

/** 把内部异常翻译成信封，绝不让堆栈或数据库错误原文漏给模型。 */
export function errorToEnvelope(error: unknown): Envelope {
  if (isTefError(error)) {
    const envelope = fail(error.code, error.message, error.checks);
    // Block/CONFLICT 是判定结果，不是故障
    if (error.code === 'CONFLICT') envelope.status = 'conflict';
    return envelope;
  }
  if (error instanceof ContractValidationError) {
    return fail('VALIDATION_ERROR', error.message, error.issues.map((issue) => ({
      id: issue.path || '(root)',
      ok: false,
      code: 'VALIDATION_ERROR',
      message: issue.message,
    })));
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return fail('VALIDATION_ERROR', error.message);
  }
  return fail('INTERNAL', 'an internal error occurred; the operation was not committed');
}

export function envelopeToToolResult(envelope: Envelope): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: envelope.status === 'error',
  };
}

export type { DiffEntry, Envelope, EnvelopeStatus, RiskOutcome };

export { TefError };

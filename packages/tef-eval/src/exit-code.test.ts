import { describe, expect, it } from 'vitest';
import { resolveExitCode } from './exit-code';

describe('resolveExitCode', () => {
  it('returns 0 for a normal batch, including measured error decisions', () => {
    expect(resolveExitCode({ loadFailed: false, thrownSampleError: false })).toBe(0);
  });

  it('returns 1 when a sample execution threw', () => {
    expect(resolveExitCode({ loadFailed: false, thrownSampleError: true })).toBe(1);
  });

  it('returns 2 when sample loading or validation failed', () => {
    expect(resolveExitCode({ loadFailed: true, thrownSampleError: false })).toBe(2);
  });

  it('prioritises load failure over thrown sample errors', () => {
    // 正常流程不会同时出现；这里固定优先级，避免未来重构产生歧义。
    expect(resolveExitCode({ loadFailed: true, thrownSampleError: true })).toBe(2);
  });

  it('returns 1 when the requested e2e layer was skipped for a missing database', () => {
    expect(
      resolveExitCode({ loadFailed: false, thrownSampleError: false, e2eSkipped: true }),
    ).toBe(1);
  });

  it('allows a missing database only with --allow-missing-db', () => {
    expect(
      resolveExitCode({
        loadFailed: false,
        thrownSampleError: false,
        e2eSkipped: true,
        allowMissingDb: true,
      }),
    ).toBe(0);
    // 数据库没有缺失时，该 flag 不会影响正常退出码。
    expect(
      resolveExitCode({
        loadFailed: false,
        thrownSampleError: false,
        e2eSkipped: false,
        allowMissingDb: true,
      }),
    ).toBe(0);
  });
});

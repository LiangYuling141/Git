import { describe, expect, it } from 'vitest';
import { resolveExitCode } from './exit-code';

describe('resolveExitCode', () => {
  it('returns 0 for a normal batch, including measured error decisions', () => {
    expect(
      resolveExitCode({ loadFailed: false, unknownContract: false, thrownSampleError: false }),
    ).toBe(0);
  });

  it('returns 1 when a sample execution threw', () => {
    expect(
      resolveExitCode({ loadFailed: false, unknownContract: false, thrownSampleError: true }),
    ).toBe(1);
  });

  it('returns 2 when sample loading or validation failed', () => {
    expect(
      resolveExitCode({ loadFailed: true, unknownContract: false, thrownSampleError: false }),
    ).toBe(2);
  });

  it('returns 1 when a sample references an unknown contract', () => {
    // 未知契约是样本/注册配置错误，不是测得的决策；必须让 CI 失败。
    expect(
      resolveExitCode({ loadFailed: false, unknownContract: true, thrownSampleError: false }),
    ).toBe(1);
    expect(
      resolveExitCode({ loadFailed: false, unknownContract: true, thrownSampleError: true }),
    ).toBe(1);
    // 数据库缺失跳过同时出现时，未知契约优先，但退出码同为 1。
    expect(
      resolveExitCode({
        loadFailed: false,
        unknownContract: true,
        thrownSampleError: false,
        e2eSkipped: true,
        allowMissingDb: true,
      }),
    ).toBe(1);
  });

  it('prioritises load failure over unknown contracts', () => {
    expect(
      resolveExitCode({ loadFailed: true, unknownContract: true, thrownSampleError: false }),
    ).toBe(2);
  });

  it('prioritises load failure over thrown sample errors', () => {
    // 正常流程不会同时出现；这里固定优先级，避免未来重构产生歧义。
    expect(
      resolveExitCode({ loadFailed: true, unknownContract: false, thrownSampleError: true }),
    ).toBe(2);
  });

  it('returns 1 when the requested e2e layer was skipped for a missing database', () => {
    expect(
      resolveExitCode({
        loadFailed: false,
        unknownContract: false,
        thrownSampleError: false,
        e2eSkipped: true,
      }),
    ).toBe(1);
  });

  it('allows a missing database only with --allow-missing-db', () => {
    expect(
      resolveExitCode({
        loadFailed: false,
        unknownContract: false,
        thrownSampleError: false,
        e2eSkipped: true,
        allowMissingDb: true,
      }),
    ).toBe(0);
    // 数据库没有缺失时，该 flag 不会影响正常退出码。
    expect(
      resolveExitCode({
        loadFailed: false,
        unknownContract: false,
        thrownSampleError: false,
        e2eSkipped: false,
        allowMissingDb: true,
      }),
    ).toBe(0);
  });
});

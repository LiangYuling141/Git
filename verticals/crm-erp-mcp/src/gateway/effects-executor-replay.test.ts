import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectExecutionError, EffectsExecutionUnknownError } from '@lymtrix/tef-core';
import { withTenantScope } from '@lymtrix/tef-mcp-kit/tenant-scope';
import { executeCrmEffectsInProcess } from './effects-executor';

/**
 * 冲突后重读幂等记录的单测（不依赖数据库）。
 *
 * 关键语义：只有“确实没有幂等记录”才是确定冲突；读取记录本身失败时无法
 * 判断副作用是否已提交，必须抛 EffectsExecutionUnknownError 交给状态机/
 * 对账收敛为 unknown，不能让调用方误以为可以换 key 重试。
 */

vi.mock('@lymtrix/tef-mcp-kit/tenant-scope', () => ({
  withTenantScope: vi.fn(),
}));

const withTenantScopeMock = vi.mocked(withTenantScope);

function baseRequest() {
  return {
    tenantId: 't_unit',
    idempotencyKey: 'idem_unit_replay',
    previewId: 'pv_unit',
    traceId: 'tr_unit',
    effects: [],
  };
}

describe('executeCrmEffectsInProcess：冲突后的幂等重读', () => {
  beforeEach(() => {
    withTenantScopeMock.mockReset();
  });

  it('重读抛错时抛出 EffectsExecutionUnknownError，而不是确定 CONFLICT', async () => {
    withTenantScopeMock
      .mockRejectedValueOnce(new EffectExecutionError('CONFLICT', 'simulated inventory guard conflict'))
      .mockRejectedValueOnce(new Error('simulated idempotency read failure'));

    await expect(executeCrmEffectsInProcess(baseRequest())).rejects.toBeInstanceOf(
      EffectsExecutionUnknownError,
    );
    expect(withTenantScopeMock).toHaveBeenCalledTimes(2);
  });

  it('P2002 后重读抛错同样视为 unknown，而不是 INTERNAL 失败', async () => {
    const uniqueConstraint = Object.assign(new Error('unique constraint'), { code: 'P2002' });
    withTenantScopeMock
      .mockRejectedValueOnce(uniqueConstraint)
      .mockRejectedValueOnce(new Error('simulated idempotency read failure'));

    await expect(executeCrmEffectsInProcess(baseRequest())).rejects.toBeInstanceOf(
      EffectsExecutionUnknownError,
    );
  });

  it('确认记录不存在时仍是确定 CONFLICT', async () => {
    withTenantScopeMock
      .mockRejectedValueOnce(new EffectExecutionError('CONFLICT', 'simulated inventory guard conflict'))
      .mockResolvedValueOnce(null);

    const result = await executeCrmEffectsInProcess(baseRequest());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONFLICT');
  });

  it('EffectExecutionError INTERNAL 仍是确定性失败，不升级为 unknown', async () => {
    withTenantScopeMock.mockRejectedValueOnce(
      new EffectExecutionError('INTERNAL', 'no adapter registered for entity "invoice"'),
    );

    const result = await executeCrmEffectsInProcess(baseRequest());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INTERNAL');
  });

  it('无法证明事务已回滚的驱动/连接异常抛 EffectsExecutionUnknownError', async () => {
    withTenantScopeMock.mockRejectedValueOnce(new Error('connection reset by peer'));

    await expect(executeCrmEffectsInProcess(baseRequest())).rejects.toBeInstanceOf(
      EffectsExecutionUnknownError,
    );
  });
});

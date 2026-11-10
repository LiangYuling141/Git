import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * effects 内部网关的“结果未知”映射单测（不依赖数据库）。
 *
 * 执行器无法确认提交结果时必须抛 EffectsExecutionUnknownError；路由必须把它
 * 翻译成结构化的 503 / EXECUTION_UNKNOWN，而不是 500 / INTERNAL。否则调用方
 * 会把“可能已提交”误判为确定失败，换一个幂等键重试，产生第二次副作用。
 */

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('@lymtrix/vertical-crm-erp', () => ({
  executeCrmEffectsInProcess: mocks.execute,
}));

import { EffectsExecutionUnknownError } from '@lymtrix/tef-core';
import { POST } from './route';

const AUTH_VALUE = 'route-test-service-token';

function effectsRequest(body: unknown): Request {
  return new Request('http://localhost/api/internal/v1/effects/execute', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${AUTH_VALUE}`,
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  tenantId: 't_route_test',
  idempotencyKey: 'idem_route_unknown',
  effects: [
    {
      type: 'update',
      entity: 'product',
      target: 'p_route_test',
      payload: {},
      increment: { availableQty: -1 },
    },
  ],
};

let savedToken: string | undefined;
let savedEnabled: string | undefined;

beforeEach(() => {
  savedToken = process.env.TEF_CRM_SERVICE_TOKEN;
  savedEnabled = process.env.TEF_CRM_EFFECTS_ENABLED;
  process.env.TEF_CRM_SERVICE_TOKEN = AUTH_VALUE;
  process.env.TEF_CRM_EFFECTS_ENABLED = '1';
  mocks.execute.mockReset();
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.TEF_CRM_SERVICE_TOKEN;
  else process.env.TEF_CRM_SERVICE_TOKEN = savedToken;
  if (savedEnabled === undefined) delete process.env.TEF_CRM_EFFECTS_ENABLED;
  else process.env.TEF_CRM_EFFECTS_ENABLED = savedEnabled;
});

describe('effects:execute 路由：执行结果未知', () => {
  it('EffectsExecutionUnknownError → 503 结构化 EXECUTION_UNKNOWN', async () => {
    mocks.execute.mockRejectedValueOnce(
      new EffectsExecutionUnknownError('could not confirm whether effects were committed'),
    );

    const response = await POST(effectsRequest(VALID_BODY));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'EXECUTION_UNKNOWN',
        message: 'could not confirm whether effects were committed',
      },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({
      tenantId: VALID_BODY.tenantId,
      idempotencyKey: VALID_BODY.idempotencyKey,
    });
  });

  it('确定性 CONFLICT 仍以 409 结构化返回，不升级为 unknown', async () => {
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      refs: {},
      error: { code: 'CONFLICT', message: 'target "p_route_test" not found' },
    });

    const response = await POST(effectsRequest(VALID_BODY));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: 'target "p_route_test" not found' },
    });
  });

  it('请求校验失败仍在调用执行器之前返回 400', async () => {
    const response = await POST(effectsRequest({ tenantId: 't_route_test', effects: [] }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

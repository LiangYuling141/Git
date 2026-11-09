import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueTokenString } from '@lymtrix/tef-mcp-kit/token';
import type { TaskState } from '@/tef/types';

/**
 * 确认路由的重试语义（模块级 mock，不依赖数据库）。
 *
 * 核心回归：上一笔执行结果未知时，原令牌可能已被 Phase 1 消费。路由必须
 * 先读 TaskState、跳过 confirmation.approve，用同一幂等键直接重试执行；
 * 确定结果后再清空 marker/key。
 */

const mocks = vi.hoisted(() => ({
  toolCalls: [] as Array<{ clientKind: string; tool: string; args: Record<string, unknown> }>,
  responses: {} as Record<string, unknown>,
  load: vi.fn(),
  update: vi.fn(),
  findSession: vi.fn(),
  resolveTenant: vi.fn(),
  /** 可注入失败：模拟执行阶段连接服务不可用。 */
  connect: vi.fn(),
  failAgentConnect: false,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 's_confirm' }) }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: mocks.findSession } },
}));

vi.mock('@/tef/tenant', () => ({
  resolveTenantContext: mocks.resolveTenant,
}));

vi.mock('@/tef/token', () => ({
  loadTokenSecret: () => 'test-secret-test-secret-test-secret',
}));

vi.mock('@/tef/task-state', () => ({
  taskStateStore: { load: mocks.load, update: mocks.update },
}));

vi.mock('@/mcp-server', () => ({
  connectTefClient: mocks.connect,
}));

import { POST } from './route';

function makeState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'ts_confirm',
    tenantId: 't_yiwu_demo',
    userId: 'u_owner',
    conversationId: 'conv_confirm',
    status: 'awaiting_confirmation',
    clarificationRounds: 0,
    version: 3,
    updatedAt: new Date('2026-11-10T00:00:00.000Z'),
    traceId: 'tr_task',
    pendingPreview: {
      previewId: 'pv_1',
      intentHash: 'ih_1',
      contract: 'create_order',
      contractVersion: '1.0',
      expiresAt: new Date('2026-11-10T00:15:00.000Z'),
    },
    // marker 重试只认与 marker 一起持久化的 intent，而不是 pending 快照。
    intent: { kind: 'operation', contract: 'create_order', slots: {} },
    idempotencyKey: 'idem_confirm',
    ...overrides,
  };
}

function post(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/agent/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TEST_SECRET = 'test-secret-test-secret-test-secret';

/** 签一个真实令牌，用于验证“令牌契约必须与 marker 契约一致”的纵深防御。 */
function signedToken(contract: string): string {
  return issueTokenString(
    {
      tenantId: 't_yiwu_demo',
      userId: 'u_owner',
      sessionId: 's_confirm',
      previewId: 'pv_signed',
      intentHash: 'ih_signed',
      contract,
      contractVersion: '1.0',
      risk: 'L1',
      requiresApproval: false,
      issuedAt: '2026-11-10T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    TEST_SECRET,
  );
}

const SUCCESS: Record<string, unknown> = {
  status: 'ok',
  data: {
    orderId: 'o_1',
    orderNo: 'SO-1',
    totalAmount: 200,
    deposit: 0,
    balance: 200,
    termsDays: 0,
  },
  auditId: 'aud_exec',
  traceId: 'tr_exec',
};

beforeEach(() => {
  mocks.toolCalls.length = 0;
  for (const key of Object.keys(mocks.responses)) delete mocks.responses[key];
  mocks.load.mockReset();
  mocks.update.mockReset();
  mocks.findSession.mockReset();
  mocks.resolveTenant.mockReset();
  mocks.connect.mockReset();
  mocks.failAgentConnect = false;

  mocks.connect.mockImplementation(async ({ principal }: { principal: { clientKind: string } }) => {
    if (mocks.failAgentConnect && principal.clientKind === 'agent') {
      mocks.failAgentConnect = false;
      throw new Error('connect refused');
    }
    return {
      async callTool(tool: string, args: Record<string, unknown>) {
        mocks.toolCalls.push({ clientKind: principal.clientKind, tool, args });
        const response = mocks.responses[tool];
        if (!response) throw new Error(`unexpected tool ${tool}`);
        return response;
      },
      async close() {
        // no-op
      },
    };
  });

  mocks.findSession.mockResolvedValue({
    id: 's_confirm',
    userId: 'u_owner',
    tenantId: 't_yiwu_demo',
    expiresAt: null,
  });
  mocks.resolveTenant.mockResolvedValue({
    tenantId: 't_yiwu_demo',
    userId: 'u_owner',
    role: 'owner',
  });
  mocks.update.mockResolvedValue(undefined);
});

describe('确认路由：未结算执行的重试', () => {
  it('marker 存在时跳过 confirmation.approve，用同一 key 重试；仍未结算则保持 executing', async () => {
    mocks.load.mockResolvedValue(makeState({ status: 'executing', pendingExecutionAttemptId: 'att_1' }));
    mocks.responses['order.execute_create'] = {
      status: 'error',
      error: { code: 'EXECUTION_UNKNOWN', message: 'commit outcome unknown' },
      data: { attemptId: 'att_1', retryWithSameKey: true },
      traceId: 'tr_exec',
    };

    const response = await POST(
      post({ confirmationToken: 'ct_used', action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    // 关键：已消费/已批准的令牌不再走 approve；直接同 key 执行。
    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['order.execute_create']);
    expect(mocks.toolCalls[0].clientKind).toBe('agent');
    expect(mocks.toolCalls[0].args).toEqual({
      confirmation_token: 'ct_used',
      idempotency_key: 'idem_confirm',
    });

    expect(payload.status).toBe('executing');
    expect(payload.approved).toBe(true);
    expect(payload.reply).toContain('待对账');

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][2]).toMatchObject({
      status: 'executing',
      idempotencyKey: 'idem_confirm',
      pendingExecutionAttemptId: 'att_1',
      // 结果仍未结算：令牌必须随 marker 保留，供下一次直接重试。
      pendingConfirmationToken: 'ct_used',
    });
    expect(mocks.update.mock.calls[0][3]).toBe(3);
  });

  it('marker 重试且请求未带 token：复用服务端持久化的令牌直接执行', async () => {
    mocks.load.mockResolvedValue(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: 'att_1',
        pendingConfirmationToken: 'ct_stored',
      }),
    );
    mocks.responses['order.execute_create'] = {
      status: 'error',
      error: { code: 'EXECUTION_UNKNOWN', message: 'commit outcome unknown' },
      data: { attemptId: 'att_1', retryWithSameKey: true },
      traceId: 'tr_exec',
    };

    const response = await POST(post({ action: 'approve', conversationId: 'conv_confirm' }));
    const payload = await response.json();

    // 不再要求客户端带回令牌，也绝不重新调用 confirmation.approve。
    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['order.execute_create']);
    expect(mocks.toolCalls[0].args).toEqual({
      confirmation_token: 'ct_stored',
      idempotency_key: 'idem_confirm',
    });
    expect(payload.status).toBe('executing');
    expect(mocks.update.mock.calls[0][2]).toMatchObject({
      pendingExecutionAttemptId: 'att_1',
      pendingConfirmationToken: 'ct_stored',
    });
  });

  it('marker 重试但请求与服务端都没有令牌：executing，不猜测也不新开操作', async () => {
    mocks.load.mockResolvedValue(
      makeState({ status: 'executing', pendingExecutionAttemptId: 'att_1', pendingConfirmationToken: null }),
    );

    const response = await POST(post({ action: 'approve', conversationId: 'conv_confirm' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe('executing');
    expect(payload.reply).toContain('缺少确认令牌');
    expect(mocks.toolCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('跨用户复用 TaskState 被拒绝：不能用他人的未结算 token/key 重放写入', async () => {
    mocks.load.mockResolvedValue(
      makeState({ userId: 'u_other', status: 'executing', pendingExecutionAttemptId: 'att_1' }),
    );

    const response = await POST(
      post({ confirmationToken: 'ct_used', action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe('forbidden');
    expect(mocks.toolCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('正常拒绝（无未结算执行）仍调用 confirmation.reject 并标记为 rejected', async () => {
    mocks.load.mockResolvedValue(makeState());
    mocks.responses['confirmation.reject'] = {
      status: 'ok',
      diff: [],
      auditId: 'aud_reject',
      traceId: 'tr_rejected',
    };

    const response = await POST(
      post({ confirmationToken: 'ct_fresh', action: 'reject', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['confirmation.reject']);
    expect(payload.status).toBe('failed');
    expect(mocks.update.mock.calls[0][2]).toMatchObject({
      pendingExecutionAttemptId: null,
      pendingConfirmationToken: null,
    });
  });

  it('重试后确定成功：清空 marker 与 key，任务按 completed 结算', async () => {
    mocks.load.mockResolvedValue(makeState({ status: 'executing', pendingExecutionAttemptId: 'att_1' }));
    mocks.responses['order.execute_create'] = SUCCESS;

    const response = await POST(
      post({ confirmationToken: 'ct_used', action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['order.execute_create']);
    expect(payload.status).toBe('completed');
    expect(mocks.update.mock.calls[0][2]).toMatchObject({
      status: 'completed',
      idempotencyKey: null,
      pendingExecutionAttemptId: null,
      pendingPreviewId: null,
      intent: null,
      activeOrderId: 'o_1',
    });
  });

  it('正常首次批准仍先调用 confirmation.approve，再复用持久化 key 执行', async () => {
    const token = signedToken('create_order');
    mocks.load.mockResolvedValue(makeState());
    mocks.responses['confirmation.approve'] = {
      status: 'ok',
      diff: [],
      auditId: 'aud_approve',
      traceId: 'tr_approved',
    };
    mocks.responses['order.execute_create'] = SUCCESS;

    const response = await POST(
      post({ confirmationToken: token, action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(mocks.toolCalls.map((call) => call.tool)).toEqual([
      'confirmation.approve',
      'order.execute_create',
    ]);
    expect(mocks.toolCalls[0].clientKind).toBe('confirmation-ui');
    expect(mocks.toolCalls[0].args.confirmation_token).toBe(token);
    expect(mocks.toolCalls[1].clientKind).toBe('agent');
    expect(mocks.toolCalls[1].args).toEqual({
      confirmation_token: token,
      idempotency_key: 'idem_confirm',
    });
    expect(payload.status).toBe('completed');
    expect(mocks.update.mock.calls[0][2]).toMatchObject({
      idempotencyKey: null,
      pendingExecutionAttemptId: null,
    });
  });

  it('未结算执行期间拒绝不会清空 marker，也不调用令牌工具', async () => {
    mocks.load.mockResolvedValue(makeState({ status: 'executing', pendingExecutionAttemptId: 'att_1' }));

    const response = await POST(
      post({ confirmationToken: 'ct_used', action: 'reject', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(mocks.toolCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(payload.status).toBe('executing');
    expect(payload.reply).toContain('待对账');
  });

  it('marker 重试按 intent 选择工具，忽略过期的 pendingPreview.contract', async () => {
    mocks.load.mockResolvedValue(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: 'att_1',
        pendingConfirmationToken: 'ct_stored',
        // 旧补偿快照残留；marker 的 intent 才是这次未结算写入的事实源。
        pendingPreview: {
          previewId: 'pv_stale_comp',
          intentHash: 'ih_stale_comp',
          contract: 'compensate_order',
          contractVersion: '1.0',
          expiresAt: new Date('2026-11-10T00:15:00.000Z'),
        },
        intent: { kind: 'operation', contract: 'create_order', slots: {} },
      }),
    );
    mocks.responses['order.execute_create'] = SUCCESS;

    const response = await POST(post({ action: 'approve', conversationId: 'conv_confirm' }));
    const payload = await response.json();

    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['order.execute_create']);
    expect(mocks.toolCalls[0].args).toEqual({
      confirmation_token: 'ct_stored',
      idempotency_key: 'idem_confirm',
    });
    expect(payload.status).toBe('completed');
  });

  it('marker 重试的请求令牌属于其他契约：409 executing，不调用工具', async () => {
    mocks.load.mockResolvedValue(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: 'att_1',
        intent: { kind: 'operation', contract: 'create_order', slots: {} },
      }),
    );

    // 真实签名的 compensate 令牌混入 create 的未结算重试：必须阻断。
    const response = await POST(
      post({ confirmationToken: signedToken('compensate_order'), action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe('executing');
    expect(payload.reply).toContain('不一致');
    expect(mocks.toolCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('marker 重试缺少可识别的权威契约：409 executing，不调用工具', async () => {
    mocks.load.mockResolvedValue(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: 'att_1',
        pendingConfirmationToken: 'ct_stored',
        intent: { kind: 'operation', contract: 'refund_order', slots: {} },
      }),
    );

    const response = await POST(post({ action: 'approve', conversationId: 'conv_confirm' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe('executing');
    expect(payload.reply).toContain('无法确定原操作契约');
    expect(mocks.toolCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('marker 重试返回冲突：保持 executing，不清空 marker/key/token', async () => {
    mocks.load.mockResolvedValue(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: 'att_1',
        pendingConfirmationToken: 'ct_stored',
        intent: { kind: 'operation', contract: 'create_order', slots: {} },
      }),
    );
    mocks.responses['order.execute_create'] = {
      status: 'conflict',
      error: { code: 'CONFLICT', message: 'snapshot mismatch' },
      traceId: 'tr_conflict',
    };

    const response = await POST(post({ action: 'approve', conversationId: 'conv_confirm' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe('executing');
    expect(payload.reply).toContain('待对账');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][2]).toMatchObject({
      status: 'executing',
      idempotencyKey: 'idem_confirm',
      pendingExecutionAttemptId: 'att_1',
      pendingConfirmationToken: 'ct_stored',
    });
  });

  it('marker 重试调用抛异常：409 executing，保留 marker/key/token', async () => {
    mocks.load.mockResolvedValue(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: 'att_1',
        pendingConfirmationToken: 'ct_stored',
        intent: { kind: 'operation', contract: 'create_order', slots: {} },
      }),
    );
    // 不注册 order.execute_create 响应：mock callTool 会直接抛错。

    const response = await POST(post({ action: 'approve', conversationId: 'conv_confirm' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe('executing');
    expect(payload.reply).toContain('待对账');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][2]).toMatchObject({
      status: 'executing',
      idempotencyKey: 'idem_confirm',
      pendingExecutionAttemptId: 'att_1',
      pendingConfirmationToken: 'ct_stored',
    });
  });

  it('空字符串请求令牌回退到服务端持久化令牌', async () => {
    mocks.load.mockResolvedValue(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: 'att_1',
        pendingConfirmationToken: 'ct_stored',
        intent: { kind: 'operation', contract: 'create_order', slots: {} },
      }),
    );
    mocks.responses['order.execute_create'] = SUCCESS;

    const response = await POST(post({ confirmationToken: '', action: 'approve', conversationId: 'conv_confirm' }));

    expect(response.status).toBe(200);
    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['order.execute_create']);
    expect(mocks.toolCalls[0].args).toEqual({
      confirmation_token: 'ct_stored',
      idempotency_key: 'idem_confirm',
    });
  });
});

describe('确认路由：旧确认卡片与令牌验签', () => {
  it('新 create 预览之后点击旧 compensate 卡片：409 CONFLICT，零工具调用，不写 marker', async () => {
    // 当前操作是 create（intent 与 pendingPreview 同为 create），旧卡片令牌声明 compensate。
    mocks.load.mockResolvedValue(makeState());

    const response = await POST(
      post({
        confirmationToken: signedToken('compensate_order'),
        action: 'approve',
        conversationId: 'conv_confirm',
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe('CONFLICT');
    expect(payload.message).toContain('刷新确认页');
    expect(payload.message).toContain('create_order');
    expect(payload.message).toContain('compensate_order');
    // 连 confirmation.approve 都不应调用：旧令牌不能被消费，marker 也不能被改写。
    expect(mocks.toolCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('新批准路径的令牌无法验签：409 CONFLICT，零工具调用，不写 marker', async () => {
    mocks.load.mockResolvedValue(makeState());

    const response = await POST(
      post({ confirmationToken: 'ct_not_signed', action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe('CONFLICT');
    expect(payload.message).toContain('无法验证确认令牌');
    expect(mocks.toolCalls).toHaveLength(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('新批准结果未知：marker 写回令牌声明的 intent/pending，后续重试使用正确工具', async () => {
    const token = signedToken('compensate_order');
    mocks.load.mockResolvedValueOnce(
      makeState({
        status: 'awaiting_confirmation',
        intent: {
          kind: 'operation',
          contract: 'compensate_order',
          slots: { orderId: 'o_1', reason: '客户取消' },
        },
        pendingPreview: {
          previewId: 'pv_current_comp',
          intentHash: 'ih_current_comp',
          contract: 'compensate_order',
          contractVersion: '1.0',
          expiresAt: new Date('2026-11-10T00:15:00.000Z'),
        },
      }),
    );
    mocks.responses['confirmation.approve'] = {
      status: 'ok',
      diff: [],
      auditId: 'aud_approve',
      traceId: 'tr_approved',
    };
    mocks.responses['order.execute_compensate'] = {
      status: 'error',
      error: { code: 'EXECUTION_UNKNOWN', message: 'commit outcome unknown' },
      traceId: 'tr_exec',
    };

    const response = await POST(
      post({ confirmationToken: token, action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(payload.status).toBe('executing');
    expect(mocks.toolCalls.map((call) => call.tool)).toEqual([
      'confirmation.approve',
      'order.execute_compensate',
    ]);

    const patch = mocks.update.mock.calls[0][2];
    expect(patch).toMatchObject({
      status: 'executing',
      idempotencyKey: 'idem_confirm',
      pendingExecutionAttemptId: 'pending:idem_confirm',
      pendingConfirmationToken: token,
      // marker 的权威 intent 必须来自令牌声明，而不是上一轮残留。
      intent: {
        kind: 'operation',
        contract: 'compensate_order',
        slots: { orderId: 'o_1', reason: '客户取消' },
      },
      pendingPreviewId: 'pv_signed',
      pendingContract: 'compensate_order',
      pendingContractVersion: '1.0',
    });

    // 模拟 marker 持久化后用户再次点击同一确认操作：只能用 marker 的 intent 选工具。
    mocks.load.mockResolvedValueOnce(
      makeState({
        status: 'executing',
        pendingExecutionAttemptId: patch.pendingExecutionAttemptId,
        pendingConfirmationToken: patch.pendingConfirmationToken,
        idempotencyKey: patch.idempotencyKey,
        intent: patch.intent,
        pendingPreview: {
          previewId: patch.pendingPreviewId,
          intentHash: 'ih_signed',
          contract: patch.pendingContract,
          contractVersion: patch.pendingContractVersion,
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        },
      }),
    );
    mocks.toolCalls.length = 0;
    mocks.responses['order.execute_compensate'] = {
      status: 'ok',
      data: { orderId: 'o_1' },
      auditId: 'aud_exec',
      traceId: 'tr_exec',
    };

    const retry = await POST(post({ action: 'approve', conversationId: 'conv_confirm' }));
    const retryPayload = await retry.json();

    expect(retry.status).toBe(200);
    expect(retryPayload.status).toBe('compensated');
    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['order.execute_compensate']);
    expect(mocks.toolCalls[0].args).toEqual({
      confirmation_token: token,
      idempotency_key: 'idem_confirm',
    });
  });

  it('新批准执行客户端连接失败：409 非终结 executing，写入权威 marker，不清空现场', async () => {
    const token = signedToken('create_order');
    mocks.load.mockResolvedValue(makeState());
    mocks.responses['confirmation.approve'] = {
      status: 'ok',
      diff: [],
      auditId: 'aud_approve',
      traceId: 'tr_approved',
    };
    mocks.failAgentConnect = true;

    const response = await POST(
      post({ confirmationToken: token, action: 'approve', conversationId: 'conv_confirm' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.status).toBe('executing');
    expect(payload.reply).toContain('待对账');
    // 只有人工批准调用；执行客户端连接失败，没有执行工具调用。
    expect(mocks.toolCalls.map((call) => call.tool)).toEqual(['confirmation.approve']);

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const patch = mocks.update.mock.calls[0][2];
    expect(patch).toMatchObject({
      status: 'executing',
      idempotencyKey: 'idem_confirm',
      pendingExecutionAttemptId: 'pending:idem_confirm',
      pendingConfirmationToken: token,
      intent: { kind: 'operation', contract: 'create_order', slots: {} },
      pendingPreviewId: 'pv_signed',
      pendingContract: 'create_order',
      pendingContractVersion: '1.0',
    });
    // 现场不能被清空：marker、intent、幂等键都必须保留。
    expect(patch.pendingExecutionAttemptId).not.toBeNull();
    expect(patch.intent).not.toBeNull();
    expect(patch.idempotencyKey).toBe('idem_confirm');
  });
});

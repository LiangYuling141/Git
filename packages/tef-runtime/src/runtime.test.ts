import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, TaskState } from '@lymtrix/tef-core';
import type { TefClientSession } from '@lymtrix/tef-mcp-kit';
import { executionToolFor, reportCompensation, reportExecution, runAgentTurn } from './runtime';
import type { TaskStatePatch } from './task-state';

/**
 * Runtime 的执行结果映射单测（不依赖数据库）。
 *
 * 重点是未结算执行的生命周期：EXECUTION_IN_PROGRESS / EXECUTION_UNKNOWN 表示
 * 副作用可能已经发生，Runtime 必须用一个显式 marker 锚定重试，而不是依赖
 * TaskState.status（状态会被普通聊天/澄清轮次改写）。
 */

interface FakeCall {
  name: string;
  args: Record<string, unknown>;
}

const MESSAGE = '给伟业公司下一单，5000 个圣诞球，单价 2 块';

/** 已归一化的重放槽位：重试时不需要再做客户/商品消歧。 */
const ORDER_SLOTS = {
  customerId: 'c_weiye',
  customerName: '伟业公司',
  sku: 'SKU-1',
  productTerm: '圣诞球',
  quantity: 5000,
  unitPrice: 2,
  depositRate: 0,
  termsDays: 0,
};

const PREVIEW_OK: Envelope = {
  status: 'ok',
  data: { requiresApproval: false },
  risk: 'L1',
  previewId: 'pv_runtime',
  confirmationToken: 'ct_runtime',
  expiresAt: '2026-11-10T00:15:00.000Z',
};

function createTaskState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'ts_runtime_test',
    tenantId: 't_runtime',
    userId: 'u_runtime',
    conversationId: 'conv_runtime',
    status: 'executing',
    clarificationRounds: 0,
    version: 1,
    updatedAt: new Date('2026-11-10T00:00:00.000Z'),
    pendingPreview: {
      previewId: 'pv_runtime',
      intentHash: 'ih_runtime',
      contract: 'create_order',
      contractVersion: '1.0',
      expiresAt: new Date('2026-11-10T00:15:00.000Z'),
    },
    // 默认代表“上一轮执行结果未结算”：Runtime 必须跳过意图解析，
    // 用同一 key + 同一令牌直接重试持久化的操作快照，绝不重新预览。
    pendingExecutionAttemptId: 'att_runtime',
    pendingConfirmationToken: 'ct_runtime',
    idempotencyKey: 'idem_runtime_existing',
    intent: { kind: 'operation', contract: 'create_order', slots: { ...ORDER_SLOTS } },
    ...overrides,
  };
}

/** 把 Runtime 返回的 patch 合并回 TaskState，模拟 /api/agent 的持久化。 */
function applyPatch(state: TaskState, patch: TaskStatePatch): TaskState {
  const next: TaskState = { ...state, ...patch, version: state.version + 1 };
  if (patch.pendingPreviewId === null) {
    next.pendingPreview = null;
  } else if (patch.pendingPreviewId) {
    next.pendingPreview = {
      previewId: patch.pendingPreviewId,
      intentHash: patch.pendingIntentHash ?? '',
      contract: patch.pendingContract ?? '',
      contractVersion: patch.pendingContractVersion ?? '',
      expiresAt: patch.pendingExpiresAt ?? new Date(0),
    };
  }
  return next;
}

function fakeSession(
  handler: (name: string, args: Record<string, unknown>) => Envelope,
  calls: FakeCall[],
): TefClientSession {
  return {
    client: undefined as never,
    async listTools() {
      return [];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return handler(name, args);
    },
    async close() {
      // no-op
    },
  } as unknown as TefClientSession;
}

function l1Handler(executeEnvelope: Envelope): (name: string) => Envelope {
  return (name) => {
    if (name === 'customer.search') {
      return {
        status: 'ok',
        data: { candidates: [{ id: 'c_weiye', label: '伟业公司', matchReason: 'exact' }] },
      };
    }
    if (name === 'inventory.check') {
      return {
        status: 'ok',
        data: { items: [{ productId: 'p_1', sku: 'SKU-1', name: '圣诞球', unitPrice: 2 }] },
      };
    }
    if (name === 'order.preview_create') return PREVIEW_OK;
    if (name === 'order.execute_create') return executeEnvelope;
    throw new Error(`unexpected tool ${name}`);
  };
}

async function turn(
  taskState: TaskState,
  message: string,
  session: TefClientSession,
): Promise<Awaited<ReturnType<typeof runAgentTurn>>> {
  return runAgentTurn({
    message,
    conversationId: taskState.conversationId,
    principal: {
      tenantId: taskState.tenantId,
      userId: taskState.userId,
      sessionId: 's_runtime',
      role: 'sales',
    },
    taskState,
    traceId: 'tr_runtime',
    secret: 'test-secret-test-secret-test-secret',
    connectSession: async () => session,
  });
}

beforeEach(() => {
  // 强制走确定性意图解析器：本文件只验证 Runtime 的执行结果映射。
  vi.stubEnv('DEEPSEEK_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Runtime：结果未知时保留幂等键、意图与 pending', () => {
  const pendingEnvelope = (code: 'EXECUTION_IN_PROGRESS' | 'EXECUTION_UNKNOWN'): Envelope => ({
    status: 'error',
    error: { code, message: 'execution is not settled' },
    data: { attemptId: 'att_runtime', retryWithSameKey: true },
  });

  it.each(['EXECUTION_IN_PROGRESS', 'EXECUTION_UNKNOWN'] as const)(
    '%s → executing，复用未结算执行的幂等键，写入 marker 并保留可重放意图',
    async (code) => {
      const calls: FakeCall[] = [];
      const taskState = createTaskState();
      const session = fakeSession(l1Handler(pendingEnvelope(code)), calls);

      const result = await turn(taskState, MESSAGE, session);

      // marker 重试必须直接执行：不得重新预览（预览会签发新令牌/新快照）。
      expect(calls.map((call) => call.name)).toEqual(['order.execute_create']);
      const executeCall = calls[0];
      // 同 key + 同令牌，否则重试会变成第二次副作用或消费错令牌。
      expect(executeCall.args).toEqual({
        confirmation_token: 'ct_runtime',
        idempotency_key: 'idem_runtime_existing',
      });

      expect(result.status).toBe('executing');
      expect(result.reply).toContain('待对账');
      expect(result.reply).toContain('同一操作');
      expect(result.reply).toContain('不要重新预览');
      // marker、key、pending 与操作快照必须原样保留，供下一次同一操作重试。
      expect(result.patch).toMatchObject({
        status: 'executing',
        idempotencyKey: 'idem_runtime_existing',
        pendingExecutionAttemptId: 'att_runtime',
        pendingConfirmationToken: 'ct_runtime',
        pendingPreviewId: 'pv_runtime',
        pendingIntentHash: 'ih_runtime',
        pendingContract: 'create_order',
        pendingContractVersion: '1.0',
        intent: {
          kind: 'operation',
          contract: 'create_order',
          slots: expect.objectContaining({ customerId: 'c_weiye', sku: 'SKU-1', quantity: 5000 }),
        },
      });
    },
  );

  it('首次执行落到 unknown：持久化预览签发并实际用于执行的令牌', async () => {
    const calls: FakeCall[] = [];
    const initial = createTaskState({
      status: 'idle',
      pendingExecutionAttemptId: null,
      pendingConfirmationToken: null,
      idempotencyKey: null,
      intent: null,
      pendingPreview: null,
    });
    const session = fakeSession(
      l1Handler({
        status: 'error',
        error: { code: 'EXECUTION_UNKNOWN', message: 'commit outcome unknown' },
        data: { attemptId: 'att_runtime', retryWithSameKey: true },
      }),
      calls,
    );

    const result = await turn(initial, MESSAGE, session);
    const executeCall = calls.find((call) => call.name === 'order.execute_create');

    expect(result.status).toBe('executing');
    expect(executeCall?.args.confirmation_token).toBe('ct_runtime');
    // 下一次 marker 重试必须能直接用这个令牌，不能重新预览。
    expect(result.patch.pendingConfirmationToken).toBe('ct_runtime');
    expect(result.patch.pendingExecutionAttemptId).toBe('att_runtime');
    expect(result.patch.idempotencyKey).toBe(executeCall?.args.idempotency_key);
  });

  it('marker 存在但缺少持久化令牌：executing，不调用工具、不生成新 key', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession(() => {
      throw new Error('no tool should be called without the stored confirmation token');
    }, calls);

    const result = await turn(createTaskState({ pendingConfirmationToken: null }), MESSAGE, session);

    expect(result.status).toBe('executing');
    expect(result.reply).toContain('待对账');
    expect(result.reply).toContain('确认令牌');
    expect(result.patch.pendingExecutionAttemptId).toBe('att_runtime');
    expect(result.patch.idempotencyKey).toBe('idem_runtime_existing');
    expect(calls).toHaveLength(0);
  });

  it('补偿 marker 重试直接调用 order.execute_compensate，不重新预览', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession((name) => {
      if (name === 'order.execute_compensate') {
        return { status: 'ok', data: { orderId: 'o_comp' }, auditId: 'aud_comp' };
      }
      throw new Error(`unexpected tool ${name}`);
    }, calls);

    const result = await turn(
      createTaskState({
        status: 'executing',
        pendingPreview: {
          previewId: 'pv_comp',
          intentHash: 'ih_comp',
          contract: 'compensate_order',
          contractVersion: '1.0',
          expiresAt: new Date('2026-11-10T00:15:00.000Z'),
        },
        intent: { kind: 'operation', contract: 'compensate_order', slots: { orderId: 'o_comp' } },
        pendingConfirmationToken: 'ct_comp',
      }),
      MESSAGE,
      session,
    );

    expect(calls.map((call) => call.name)).toEqual(['order.execute_compensate']);
    expect(calls[0].args).toEqual({
      confirmation_token: 'ct_comp',
      idempotency_key: 'idem_runtime_existing',
    });
    expect(result.status).toBe('compensated');
    expect(result.patch.pendingExecutionAttemptId).toBeNull();
    expect(result.patch.pendingConfirmationToken).toBeNull();
  });

  it('marker 重试以 intent 契约为准，忽略过期的 pendingPreview 契约', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession((name) => {
      if (name === 'order.execute_create') {
        return { status: 'conflict', error: { code: 'CONFLICT', message: 'snapshot mismatch' }, traceId: 'tr_conflict' };
      }
      throw new Error(`unexpected tool ${name}`);
    }, calls);

    const result = await turn(
      createTaskState({
        // 历史残留：旧补偿预览仍在，但 marker 的 intent 属于新的 create 操作。
        pendingPreview: {
          previewId: 'pv_stale_comp',
          intentHash: 'ih_stale_comp',
          contract: 'compensate_order',
          contractVersion: '1.0',
          expiresAt: new Date('2026-11-10T00:15:00.000Z'),
        },
        intent: { kind: 'operation', contract: 'create_order', slots: { ...ORDER_SLOTS } },
      }),
      MESSAGE,
      session,
    );

    // 唯一被调用的工具必须来自 intent，而不是旧补偿快照。
    expect(calls.map((call) => call.name)).toEqual(['order.execute_create']);
    expect(calls[0].args).toEqual({
      confirmation_token: 'ct_runtime',
      idempotency_key: 'idem_runtime_existing',
    });

    // 冲突不能证明原 attempt 已失败：marker/key/token 必须保留现场。
    expect(result.status).toBe('executing');
    expect(result.reply).toContain('待对账');
    expect(result.patch).toMatchObject({
      idempotencyKey: 'idem_runtime_existing',
      pendingExecutionAttemptId: 'att_runtime',
      pendingConfirmationToken: 'ct_runtime',
      pendingPreviewId: 'pv_stale_comp',
      intent: { kind: 'operation', contract: 'create_order' },
    });
  });

  it('marker 重试遇到无法识别的契约：非终结 executing，不调用工具且保留现场', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession(() => {
      throw new Error('no tool should be called without an executable contract');
    }, calls);

    const result = await turn(
      createTaskState({ intent: { kind: 'operation', contract: 'refund_order', slots: {} } }),
      MESSAGE,
      session,
    );

    expect(result.status).toBe('executing');
    expect(result.reply).toContain('无法确定原操作契约');
    expect(result.patch).toMatchObject({
      idempotencyKey: 'idem_runtime_existing',
      pendingExecutionAttemptId: 'att_runtime',
      pendingConfirmationToken: 'ct_runtime',
      intent: { kind: 'operation', contract: 'refund_order' },
    });
    expect(calls).toHaveLength(0);
  });

  it('marker 重试的调用抛异常：返回 executing 并保留 marker/key/token', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession(() => {
      throw new Error('socket hang up');
    }, calls);

    const result = await turn(createTaskState(), MESSAGE, session);

    expect(result.status).toBe('executing');
    expect(result.reply).toContain('待对账');
    expect(result.toolCalls).toEqual([{ tool: 'order.execute_create', status: 'error' }]);
    expect(result.patch).toMatchObject({
      idempotencyKey: 'idem_runtime_existing',
      pendingExecutionAttemptId: 'att_runtime',
      pendingConfirmationToken: 'ct_runtime',
      pendingPreviewId: 'pv_runtime',
    });
    expect(calls.map((call) => call.name)).toEqual(['order.execute_create']);
  });

  it('新操作执行 unknown：marker 的 pending 字段改写为当前预览与当前令牌', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession(
      l1Handler({
        status: 'error',
        error: { code: 'EXECUTION_UNKNOWN', message: 'commit outcome unknown' },
        data: { attemptId: 'att_new', retryWithSameKey: true },
      }),
      calls,
    );

    // 历史残留的补偿快照 + 当前 create 执行：marker 不能被旧快照覆盖。
    const initial = createTaskState({
      status: 'idle',
      pendingExecutionAttemptId: null,
      pendingConfirmationToken: null,
      idempotencyKey: null,
      intent: null,
      pendingPreview: {
        previewId: 'pv_stale_comp',
        intentHash: 'ih_stale_comp',
        contract: 'compensate_order',
        contractVersion: '1.0',
        expiresAt: new Date('2026-11-10T00:15:00.000Z'),
      },
    });

    const result = await turn(initial, MESSAGE, session);
    const executeCall = calls.find((call) => call.name === 'order.execute_create');

    expect(result.status).toBe('executing');
    expect(executeCall?.args.confirmation_token).toBe('ct_runtime');
    expect(result.patch).toMatchObject({
      pendingPreviewId: 'pv_runtime',
      pendingContract: 'create_order',
      pendingContractVersion: '1.0',
      pendingExpiresAt: new Date('2026-11-10T00:15:00.000Z'),
      pendingConfirmationToken: 'ct_runtime',
      pendingExecutionAttemptId: 'att_new',
      idempotencyKey: executeCall?.args.idempotency_key,
      intent: { kind: 'operation', contract: 'create_order' },
    });
  });

  it('reportExecution：两个未知错误码都映射为 executing 并写入 marker', () => {
    for (const code of ['EXECUTION_IN_PROGRESS', 'EXECUTION_UNKNOWN'] as const) {
      const result = reportExecution(pendingEnvelope(code), 'idem_runtime_existing', {
        taskState: createTaskState(),
        traceId: 'tr_runtime',
        toolCalls: [],
        intentSource: 'deterministic',
      });

      expect(result.status).toBe('executing');
      expect(result.patch.idempotencyKey).toBe('idem_runtime_existing');
      expect(result.patch.pendingExecutionAttemptId).toBe('att_runtime');
      expect(result.patch.pendingPreviewId).toBe('pv_runtime');
    }
  });

  it('reportCompensation：未知错误码同样映射为 executing 并保留 pending', () => {
    const result = reportCompensation(pendingEnvelope('EXECUTION_UNKNOWN'), 'idem_runtime_existing', {
      taskState: createTaskState({
        pendingPreview: {
          previewId: 'pv_comp',
          intentHash: 'ih_comp',
          contract: 'compensate_order',
          contractVersion: '1.0',
          expiresAt: new Date('2026-11-10T00:15:00.000Z'),
        },
      }),
      traceId: 'tr_runtime',
      toolCalls: [],
      intentSource: 'deterministic',
    });

    expect(result.status).toBe('executing');
    expect(result.patch.pendingPreviewId).toBe('pv_comp');
    expect(result.patch.pendingContract).toBe('compensate_order');
    expect(result.patch.pendingExecutionAttemptId).toBe('att_runtime');
  });

  it('错误码缺少 attemptId 时用与幂等键绑定的哨兵 marker', () => {
    const result = reportExecution(
      { status: 'error', error: { code: 'EXECUTION_UNKNOWN', message: 'unknown' } },
      'idem_sentinel',
      {
        taskState: createTaskState({ pendingExecutionAttemptId: null }),
        traceId: 'tr_runtime',
        toolCalls: [],
        intentSource: 'deterministic',
      },
    );

    expect(result.patch.pendingExecutionAttemptId).toBe('pending:idem_sentinel');
  });

  it('成功执行按 completed 结算，并清空 key 与 marker', () => {
    const result = reportExecution(
      {
        status: 'ok',
        data: { orderId: 'o_runtime', orderNo: 'SO-1', totalAmount: 200, deposit: 0, balance: 200, termsDays: 0 },
      },
      'idem_runtime_existing',
      {
        taskState: createTaskState(),
        traceId: 'tr_runtime',
        toolCalls: [],
        intentSource: 'deterministic',
      },
    );

    expect(result.status).toBe('completed');
    expect(result.patch).toMatchObject({
      idempotencyKey: null,
      pendingExecutionAttemptId: null,
      pendingPreviewId: null,
      intent: null,
    });
  });

  it('确定冲突/确定失败同样清空 key 与 marker', () => {
    for (const envelope of [
      { status: 'conflict' as const, error: { code: 'CONFLICT' as const, message: 'stock changed' } },
      { status: 'error' as const, error: { code: 'INTERNAL' as const, message: 'database exploded' } },
    ]) {
      const result = reportExecution(envelope, 'idem_runtime_existing', {
        taskState: createTaskState(),
        traceId: 'tr_runtime',
        toolCalls: [],
        intentSource: 'deterministic',
      });

      expect(result.patch.idempotencyKey).toBeNull();
      expect(result.patch.pendingExecutionAttemptId).toBeNull();
      expect(result.patch.pendingPreviewId).toBeNull();
      expect(result.patch.intent).toBeNull();
    }
  });
});

describe('Runtime：未结算执行的跨轮次生命周期', () => {
  it('未知 → 无关聊天轮次 → 重试：同 key，不解析新意图，副作用至多一次', async () => {
    const calls: FakeCall[] = [];
    const orders = new Map<string, string>();
    let settled = false;

    const session = fakeSession((name, args) => {
      if (name === 'customer.search') {
        return {
          status: 'ok',
          data: { candidates: [{ id: 'c_weiye', label: '伟业公司', matchReason: 'exact' }] },
        };
      }
      if (name === 'inventory.check') {
        return {
          status: 'ok',
          data: { items: [{ productId: 'p_1', sku: 'SKU-1', name: '圣诞球', unitPrice: 2 }] },
        };
      }
      if (name === 'order.preview_create') return PREVIEW_OK;
      if (name === 'order.execute_create') {
        const key = String(args.idempotency_key);
        // 模拟 Phase 1：首次调用已提交副作用但响应丢失；同 key 调用在
        // 对账结算前一直返回 EXECUTION_UNKNOWN，换 key 才会创建第二单。
        if (!orders.has(key)) orders.set(key, 'SO-RETRY');
        if (!settled) {
          return {
            status: 'error',
            error: { code: 'EXECUTION_UNKNOWN', message: 'commit outcome unknown' },
            data: { attemptId: 'att_runtime', retryWithSameKey: true },
          };
        }
        return {
          status: 'ok',
          data: {
            orderId: 'o_retry',
            orderNo: orders.get(key),
            totalAmount: 200,
            deposit: 0,
            balance: 200,
            termsDays: 0,
          },
          auditId: 'aud_retry',
        };
      }
      throw new Error(`unexpected tool ${name}`);
    }, calls);

    // 1. 首次执行结果未知。
    const initialState = createTaskState({ pendingExecutionAttemptId: null, idempotencyKey: null });
    const first = await turn(initialState, MESSAGE, session);
    expect(first.status).toBe('executing');
    expect(first.patch.pendingExecutionAttemptId).toBe('att_runtime');
    const firstKey = first.patch.idempotencyKey as string;
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
    // 首次执行的实际令牌来自预览，必须随 marker 一起持久化。
    expect(first.patch.pendingConfirmationToken).toBe('ct_runtime');
    const stateAfterUnknown = applyPatch(initialState, first.patch);

    // 2. 用户发了一句无关聊天：marker 优先，Runtime 不解析这句话，
    //    而是继续重试同一操作；对账尚未结算，marker 必须保留。
    const chatRound = await turn(stateAfterUnknown, '你好，在吗？', session);
    expect(chatRound.status).toBe('executing');
    expect(chatRound.intentSource).toBe('deterministic');
    expect(chatRound.patch.pendingExecutionAttemptId).toBe('att_runtime');
    expect(chatRound.patch.idempotencyKey).toBe(firstKey);
    expect(chatRound.patch.pendingConfirmationToken).toBe('ct_runtime');
    // 重试轮次绝不能再走预览：预览调用数保持为首次的那一次。
    expect(calls.filter((call) => call.name === 'order.preview_create')).toHaveLength(1);
    const stillUnknown = applyPatch(stateAfterUnknown, chatRound.patch);

    // 3. 对账结算后再重试：同一操作复用同一 key，直接拿到重放结果。
    settled = true;
    const retried = await turn(stillUnknown, '再试一次', session);
    expect(retried.status).toBe('completed');
    expect(retried.patch.idempotencyKey).toBeNull();
    expect(retried.patch.pendingExecutionAttemptId).toBeNull();

    const executeCalls = calls.filter((call) => call.name === 'order.execute_create');
    expect(executeCalls).toHaveLength(3);
    // 三次执行必须是同一个 key；换 key 会在 orders 里创建第二单。
    expect(new Set(executeCalls.map((call) => call.args.idempotency_key))).toEqual(new Set([firstKey]));
    expect(orders.size).toBe(1);

    // 4. 结算成功后是一个新操作：必须生成新 key，不能重放上一单的结果。
    const afterSettled = applyPatch(stillUnknown, retried.patch);
    const fresh = await turn(afterSettled, MESSAGE, session);
    const freshExecute = calls.filter((call) => call.name === 'order.execute_create').at(-1);
    expect(freshExecute?.args.idempotency_key).not.toBe(firstKey);
    expect(freshExecute?.args.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(orders.size).toBe(2);
    expect(fresh.status).toBe('completed');
  });

  it('marker 存在但幂等键丢失：不生成新 key，要求人工对账', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession(() => {
      throw new Error('no tool should be called without the original idempotency key');
    }, calls);

    const result = await turn(
      createTaskState({ idempotencyKey: null }),
      MESSAGE,
      session,
    );

    expect(result.status).toBe('executing');
    expect(result.reply).toContain('缺少幂等键');
    expect(result.patch.idempotencyKey).toBeNull();
    expect(result.patch.pendingExecutionAttemptId).toBe('att_runtime');
    expect(calls).toHaveLength(0);
  });

  it('marker 存在但没有可重放意图：返回 executing，不解析消息、不调用工具', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession(() => {
      throw new Error('no tool should be called while an unresolved execution has no intent snapshot');
    }, calls);

    const result = await turn(
      createTaskState({ intent: null, idempotencyKey: 'idem_lost' }),
      MESSAGE,
      session,
    );

    expect(result.status).toBe('executing');
    expect(result.reply).toContain('待对账');
    expect(result.reply).toContain('稍后重试');
    expect(result.patch.pendingExecutionAttemptId).toBe('att_runtime');
    expect(result.patch.idempotencyKey).toBe('idem_lost');
    expect(calls).toHaveLength(0);
  });

  it('完成 → 聊天 → 新订单：不复用上一单 key，也不重放旧成功', async () => {
    const calls: FakeCall[] = [];
    const session = fakeSession(
      l1Handler({
        status: 'ok',
        data: { orderId: 'o_new', orderNo: 'SO-2', totalAmount: 200, deposit: 0, balance: 200, termsDays: 0 },
        auditId: 'aud_new',
      }),
      calls,
    );

    // 模拟历史数据：已完成任务仍残留上一单的 key（修复前会在下一单命中重放）。
    const completed = createTaskState({
      status: 'completed',
      pendingExecutionAttemptId: null,
      intent: null,
      idempotencyKey: 'idem_done_previous',
    });

    const chat = await turn(completed, '你好', session);
    expect(chat.status).toBe('idle');
    const idle = applyPatch(completed, chat.patch);
    expect(idle.status).toBe('idle');
    expect(idle.idempotencyKey).toBe('idem_done_previous');

    const next = await turn(idle, MESSAGE, session);

    const executeCalls = calls.filter((call) => call.name === 'order.execute_create');
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0].args.idempotency_key).not.toBe('idem_done_previous');
    expect(executeCalls[0].args.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(next.status).toBe('completed');
    expect(next.patch.idempotencyKey).toBeNull();
    expect(next.patch.pendingExecutionAttemptId).toBeNull();
  });
});

describe('Runtime：执行工具名只来自契约白名单', () => {
  it('白名单契约映射到唯一工具', () => {
    expect(executionToolFor('create_order')).toBe('order.execute_create');
    expect(executionToolFor('compensate_order')).toBe('order.execute_compensate');
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'refund_order', ''])(
    '非白名单契约 %j 返回 null，绝不返回原型成员或函数对象',
    (contract) => {
      expect(executionToolFor(contract)).toBeNull();
    },
  );
});

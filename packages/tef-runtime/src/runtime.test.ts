import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, TaskState } from '@lymtrix/tef-core';
import type { TefClientSession } from '@lymtrix/tef-mcp-kit';
import { reportCompensation, reportExecution, runAgentTurn } from './runtime';

/**
 * Runtime 的执行结果映射单测（不依赖数据库）。
 *
 * 重点是 Critical：执行层返回 EXECUTION_IN_PROGRESS / EXECUTION_UNKNOWN 时，
 * Runtime 必须保留 pending 预览与幂等键，并明确提示“用同一操作重试”；
 * 若清空 pending 或换 key，下一次执行会绕过原 attempt，产生第二次副作用。
 */

interface FakeCall {
  name: string;
  args: Record<string, unknown>;
}

const MESSAGE = '给伟业公司下一单，5000 个圣诞球，单价 2 块';

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
    idempotencyKey: 'idem_runtime_existing',
    ...overrides,
  };
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
    if (name === 'order.preview_create') {
      return {
        status: 'ok',
        data: { requiresApproval: false },
        risk: 'L1',
        previewId: 'pv_runtime',
        confirmationToken: 'ct_runtime',
      };
    }
    if (name === 'order.execute_create') return executeEnvelope;
    throw new Error(`unexpected tool ${name}`);
  };
}

beforeEach(() => {
  // 强制走确定性意图解析器：本文件只验证 Runtime 的执行结果映射。
  vi.stubEnv('DEEPSEEK_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Runtime：结果未知时保留幂等键与 pending', () => {
  const pendingEnvelope = (code: 'EXECUTION_IN_PROGRESS' | 'EXECUTION_UNKNOWN'): Envelope => ({
    status: 'error',
    error: { code, message: 'execution is not settled' },
    data: { attemptId: 'att_runtime', retryWithSameKey: true },
  });

  it.each(['EXECUTION_IN_PROGRESS', 'EXECUTION_UNKNOWN'] as const)(
    '%s → executing，复用已持久化的幂等键，不清 pending',
    async (code) => {
      const calls: FakeCall[] = [];
      const taskState = createTaskState();
      const session = fakeSession(l1Handler(pendingEnvelope(code)), calls);

      const result = await runAgentTurn({
        message: MESSAGE,
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

      const executeCall = calls.find((call) => call.name === 'order.execute_create');
      expect(executeCall, 'Runtime should reach the L1 execute step').toBeTruthy();
      // L1 执行必须复用 TaskState 中的 key，否则 unknown 重试会变成第二次副作用。
      expect(executeCall?.args.idempotency_key).toBe('idem_runtime_existing');

      expect(result.status).toBe('executing');
      expect(result.reply).toContain('待对账');
      expect(result.reply).toContain('同一操作');
      expect(result.reply).toContain('不要重新预览');
      // pending 字段必须原样保留，供下一次同一操作重试。
      expect(result.patch).toMatchObject({
        status: 'executing',
        idempotencyKey: 'idem_runtime_existing',
        pendingPreviewId: 'pv_runtime',
        pendingIntentHash: 'ih_runtime',
        pendingContract: 'create_order',
        pendingContractVersion: '1.0',
      });
    },
  );

  it('reportExecution：两个未知错误码都映射为 executing', () => {
    for (const code of ['EXECUTION_IN_PROGRESS', 'EXECUTION_UNKNOWN'] as const) {
      const result = reportExecution(pendingEnvelope(code), 'idem_runtime_existing', {
        taskState: createTaskState(),
        traceId: 'tr_runtime',
        toolCalls: [],
        intentSource: 'deterministic',
      });

      expect(result.status).toBe('executing');
      expect(result.patch.idempotencyKey).toBe('idem_runtime_existing');
      expect(result.patch.pendingPreviewId).toBe('pv_runtime');
    }
  });

  it('reportCompensation：未知错误码同样映射为 executing 并保留 pending', () => {
    const result = reportCompensation(pendingEnvelope('EXECUTION_UNKNOWN'), 'idem_runtime_existing', {
      taskState: createTaskState({ pendingPreview: {
        previewId: 'pv_comp',
        intentHash: 'ih_comp',
        contract: 'compensate_order',
        contractVersion: '1.0',
        expiresAt: new Date('2026-11-10T00:15:00.000Z'),
      } }),
      traceId: 'tr_runtime',
      toolCalls: [],
      intentSource: 'deterministic',
    });

    expect(result.status).toBe('executing');
    expect(result.patch.pendingPreviewId).toBe('pv_comp');
    expect(result.patch.pendingContract).toBe('compensate_order');
  });

  it('成功执行仍按 completed 结算并清空 pending', () => {
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
    expect(result.patch.pendingPreviewId).toBeNull();
  });

  it('已终结任务不复用历史幂等键，避免新操作重放上一单', async () => {
    const calls: FakeCall[] = [];
    const taskState = createTaskState({ status: 'completed', idempotencyKey: 'idem_done_previous' });
    const session = fakeSession(
      l1Handler({
        status: 'ok',
        data: { orderId: 'o_new', orderNo: 'SO-2', totalAmount: 200, deposit: 0, balance: 200, termsDays: 0 },
      }),
      calls,
    );

    const result = await runAgentTurn({
      message: MESSAGE,
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

    const executeCall = calls.find((call) => call.name === 'order.execute_create');
    expect(executeCall).toBeTruthy();
    expect(executeCall?.args.idempotency_key).not.toBe('idem_done_previous');
    expect(executeCall?.args.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.status).toBe('completed');
  });
});

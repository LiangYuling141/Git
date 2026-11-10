import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@/tef/types';

/**
 * Agent 入口的 TaskState 归属校验。
 *
 * conversationId 来自请求体，`loadOrCreate` 以 (tenantId, conversationId) 为键。
 * 若不复核 userId，同一租户内的其他用户就能复用他人的任务状态与未结算
 * token/key 继续写入。本文件只 mock 会话基础设施，不依赖数据库。
 */

const mocks = vi.hoisted(() => ({
  loadOrCreate: vi.fn(),
  update: vi.fn(),
  findSession: vi.fn(),
  resolveTenant: vi.fn(),
  runAgentTurn: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 's_agent' }) }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: mocks.findSession } },
}));

vi.mock('@/agent-runtime/runtime', () => ({
  runAgentTurn: mocks.runAgentTurn,
}));

vi.mock('@/mcp-server', () => ({
  connectTefClient: vi.fn(),
}));

vi.mock('@/tef/tenant', () => ({
  resolveTenantContext: mocks.resolveTenant,
}));

vi.mock('@/tef/token', () => ({
  loadTokenSecret: () => 'test-secret-test-secret-test-secret',
}));

vi.mock('@/tef/task-state', () => ({
  taskStateStore: { loadOrCreate: mocks.loadOrCreate, update: mocks.update },
}));

import { POST } from './route';

function makeState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'ts_agent',
    tenantId: 't_yiwu_demo',
    userId: 'u_owner',
    conversationId: 'conv_owner',
    status: 'idle',
    clarificationRounds: 0,
    version: 1,
    updatedAt: new Date('2026-11-10T00:00:00.000Z'),
    ...overrides,
  };
}

function post(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.loadOrCreate.mockReset();
  mocks.update.mockReset();
  mocks.findSession.mockReset();
  mocks.resolveTenant.mockReset();
  mocks.runAgentTurn.mockReset();

  mocks.findSession.mockResolvedValue({
    id: 's_agent',
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

describe('/api/agent：TaskState 归属', () => {
  it('conversationId 属于其他用户：403，不运行 Agent、不写状态', async () => {
    mocks.loadOrCreate.mockResolvedValue(makeState({ userId: 'u_other' }));

    const response = await POST(post({ message: '你好', conversationId: 'conv_shared' }));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe('forbidden');
    expect(mocks.loadOrCreate).toHaveBeenCalledWith('t_yiwu_demo', 'conv_shared', 'u_owner');
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('同一用户的任务状态继续执行', async () => {
    mocks.loadOrCreate.mockResolvedValue(makeState());
    mocks.runAgentTurn.mockResolvedValue({
      status: 'idle',
      reply: '你好',
      patch: {},
      traceId: 'tr_agent',
      toolCalls: [],
      intentSource: 'deterministic',
    });

    const response = await POST(post({ message: '你好', conversationId: 'conv_owner' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.reply).toBe('你好');
    expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});

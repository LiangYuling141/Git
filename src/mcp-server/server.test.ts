import { describe, expect, it } from 'vitest';
import { canCallTool, toolsForClient } from '@/tef/tenant';
import { visibleToolsFor } from './server';
import { connectTefClient } from './transport';
import type { Principal } from './principal';

/**
 * §6.4 工具可见性隔离。
 *
 * 这条性质是整个"确认不可绕过"论证的物理基础：模型不是被叮嘱不要自己确认，
 * 而是它所在的 client 里根本没有注册 confirmation.approve 这个工具。
 */

const SECRET = 'test-secret-that-is-long-enough-to-be-accepted';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    tenantId: 't_yiwu_demo',
    userId: 'admin',
    sessionId: 's_1',
    role: 'owner',
    clientKind: 'agent',
    ...overrides,
  };
}

async function registeredTools(p: Principal): Promise<string[]> {
  const session = await connectTefClient({ principal: p, traceId: 'tr_test', secret: SECRET });
  try {
    // 走真实的 MCP 协议栈：客户端能列出什么，就是服务端注册了什么。
    const result = await session.client.listTools();
    return result.tools.map((tool) => tool.name).sort();
  } finally {
    await session.close();
  }
}

describe('toolsForClient（按 client 身份注册）', () => {
  it('Agent Runtime 看不到 confirmation.approve / confirmation.reject', () => {
    const agentTools = toolsForClient('agent');
    expect(agentTools).not.toContain('confirmation.approve');
    expect(agentTools).not.toContain('confirmation.reject');
  });

  it('Agent Runtime 能看到查询、预览与执行工具', () => {
    const agentTools = toolsForClient('agent');
    for (const tool of ['customer.search', 'customer.get', 'credit.get', 'inventory.check', 'order.preview_create', 'order.execute_create']) {
      expect(agentTools).toContain(tool);
    }
  });

  it('人工确认 UI 能看到治理工具，但看不到执行工具', () => {
    const uiTools = toolsForClient('confirmation-ui');
    expect(uiTools).toContain('confirmation.approve');
    expect(uiTools).toContain('confirmation.reject');
    expect(uiTools).not.toContain('order.execute_create');
    expect(uiTools).not.toContain('order.preview_create');
  });

  it('运维后台能看到治理与白名单工具', () => {
    const opsTools = toolsForClient('ops');
    expect(opsTools).toContain('audit.trace');
    expect(opsTools).toContain('whitelist.list');
    expect(opsTools).toContain('confirmation.approve');
  });
});

describe('canCallTool（§11.2 角色 scope）', () => {
  it('viewer 只能调查询类工具', () => {
    expect(canCallTool('viewer', 'customer.search')).toBe(true);
    expect(canCallTool('viewer', 'credit.get')).toBe(true);
    expect(canCallTool('viewer', 'order.preview_create')).toBe(false);
    expect(canCallTool('viewer', 'order.execute_create')).toBe(false);
    expect(canCallTool('viewer', 'confirmation.approve')).toBe(false);
  });

  it('sales 可以查询与写入订单，但不能批准确认', () => {
    expect(canCallTool('sales', 'order.preview_create')).toBe(true);
    expect(canCallTool('sales', 'order.execute_create')).toBe(true);
    expect(canCallTool('sales', 'confirmation.approve')).toBe(false);
  });

  it('finance 不能修改客户档案，但可以读', () => {
    expect(canCallTool('finance', 'customer.get')).toBe(true);
    expect(canCallTool('finance', 'customer.create')).toBe(false);
    expect(canCallTool('finance', 'payment.execute_record')).toBe(true);
  });

  it('owner 可以批准', () => {
    expect(canCallTool('owner', 'confirmation.approve')).toBe(true);
  });

  it('未知角色一律拒绝', () => {
    expect(canCallTool('ghost' as never, 'customer.search')).toBe(false);
  });
});

describe('MCP Server 实际注册的工具集', () => {
  it('Agent Runtime（owner）拿到的是查询+预览+执行+策略，没有治理工具', async () => {
    const tools = await registeredTools(principal({ clientKind: 'agent', role: 'owner' }));
    expect(tools).not.toContain('confirmation.approve');
    expect(tools).not.toContain('confirmation.reject');
    expect(tools).toContain('order.preview_create');
    expect(tools).toContain('order.execute_create');
    expect(tools).toContain('policy.get');
  });

  it('人工确认 UI（owner）拿到的是治理+查询，没有执行工具', async () => {
    const tools = await registeredTools(principal({ clientKind: 'confirmation-ui', role: 'owner' }));
    expect(tools).toContain('confirmation.approve');
    expect(tools).toContain('confirmation.reject');
    expect(tools).not.toContain('order.execute_create');
    expect(tools).not.toContain('order.preview_create');
  });

  it('viewer 角色即使在 agent client 上也拿不到写工具', async () => {
    const tools = await registeredTools(principal({ clientKind: 'agent', role: 'viewer' }));
    expect(tools).not.toContain('order.preview_create');
    expect(tools).not.toContain('order.execute_create');
    expect(tools).toContain('customer.search');
  });

  it('sales 在人工确认 UI 上也拿不到 approve——角色与 client 身份是两道独立的门', async () => {
    const tools = await registeredTools(principal({ clientKind: 'confirmation-ui', role: 'sales' }));
    expect(tools).not.toContain('confirmation.approve');
  });

  it('visibleToolsFor 与实际注册结果一致', async () => {
    const p = principal({ clientKind: 'agent', role: 'owner' });
    expect(await registeredTools(p)).toEqual([...visibleToolsFor(p)].sort());
  });
});

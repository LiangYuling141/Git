import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Operation, Session } from '@/types';

const VALID_KEY = 'sk-test-1234567890abcdefghijklmn';

const OPERATION: Operation = {
  id: 'op_1',
  type: 'update',
  entity: 'order',
  action: 'update',
  description: '更新订单备注',
  amount: 500,
};

const SESSION: Session = {
  id: 's_1',
  userId: 'admin',
  userName: 'Admin',
  riskLevel: 'L1',
  createdAt: new Date(),
  metadata: {},
};

function llmResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_1',
      model: 'deepseek-chat',
      choices: [
        { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function loadAgent(name: 'SubAgent1' | 'SubAgent2') {
  vi.resetModules();
  vi.stubEnv('DEEPSEEK_API_KEY', VALID_KEY);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(llmResponse('{"passed":"yes"}')));

  if (name === 'SubAgent1') {
    const { SubAgent1 } = await import('./SubAgent1');
    return new SubAgent1();
  }

  const { SubAgent2 } = await import('./SubAgent2');
  return new SubAgent2();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('子 Agent 模型输出校验', () => {
  it('SubAgent1 拒绝非布尔 passed，避免字符串真值绕过', async () => {
    const agent = await loadAgent('SubAgent1');

    const vote = await agent.vote(OPERATION, SESSION);

    expect(vote).toBe('reject');
    expect(agent.getLastResult().passed).toBe(false);
  });

  it('SubAgent2 拒绝非布尔 passed，避免字符串真值绕过', async () => {
    const agent = await loadAgent('SubAgent2');

    const vote = await agent.vote(OPERATION, SESSION);

    expect(vote).toBe('reject');
    expect(agent.getLastResult().passed).toBe(false);
  });
});

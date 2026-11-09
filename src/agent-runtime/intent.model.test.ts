import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIntent } from './intent';

const VALID_KEY = 'sk-test-1234567890abcdefghijklmn';

const MESSAGE = '给伟业公司下一单，5000 个圣诞球，单价 2 块，先付 30% 定金，余款 30 天账期';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('parseIntent 模型路径', () => {
  it('模型返回合契约 JSON 时采用模型结果，并丢弃 confidence', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', VALID_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        llmResponse(
          JSON.stringify({
            kind: 'operation',
            contract: 'create_order',
            slots: {
              customerName: '伟业公司',
              quantity: 5000,
              unitPrice: 2,
              depositRate: 0.3,
              termsDays: 30,
            },
            // 模型自报的 confidence 不可信，必须被 schema 丢弃
            confidence: 0.99,
          }),
        ),
      ),
    );

    const result = await parseIntent(MESSAGE);

    expect(result.source).toBe('model');
    expect(result.intent).toEqual({
      kind: 'operation',
      contract: 'create_order',
      slots: {
        customerName: '伟业公司',
        quantity: 5000,
        unitPrice: 2,
        depositRate: 0.3,
        termsDays: 30,
      },
    });
    expect(result.intent).not.toHaveProperty('confidence');
  });

  it('模型输出不合契约时回落确定性解析器', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', VALID_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(llmResponse(JSON.stringify({ kind: 'operation', contract: 123 }))),
    );

    const result = await parseIntent(MESSAGE);

    expect(result.source).toBe('deterministic');
    expect(result.intent.kind).toBe('operation');
  });

  it('未配置 Key 时不发起网络请求，直接走确定性解析器', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseIntent(MESSAGE);

    expect(result.source).toBe('deterministic');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

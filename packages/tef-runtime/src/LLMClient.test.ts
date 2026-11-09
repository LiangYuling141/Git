import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEEPSEEK_API_BASE,
  DEFAULT_DEEPSEEK_MODEL,
  LLMClient,
  isDeepSeekConfigured,
} from './LLMClient';

const VALID_KEY = 'sk-test-1234567890abcdefghijklmn';

function okResponse(content = '{"ok":true}'): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_1',
      model: DEFAULT_DEEPSEEK_MODEL,
      choices: [
        { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('isDeepSeekConfigured', () => {
  it('空值、占位符和过短 Key 都视为未配置', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    expect(isDeepSeekConfigured()).toBe(false);

    vi.stubEnv('DEEPSEEK_API_KEY', 'your_deepseek_api_key_here');
    expect(isDeepSeekConfigured()).toBe(false);

    vi.stubEnv('DEEPSEEK_API_KEY', 'short');
    expect(isDeepSeekConfigured()).toBe(false);
  });

  it('有效 Key 视为已配置', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', VALID_KEY);
    expect(isDeepSeekConfigured()).toBe(true);
  });
});

describe('LLMClient.chat', () => {
  it('使用 OpenAI 兼容端点，只发送标准字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new LLMClient(VALID_KEY);
    const result = await client.chat({
      messages: [{ role: 'user', content: '你好' }],
      temperature: 0.1,
      max_tokens: 100,
    });

    expect(result.choices[0].message.content).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_DEEPSEEK_API_BASE}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${VALID_KEY}`);

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
    expect(body).not.toHaveProperty('bot_setting');
  });

  it('请求级 model 覆盖环境默认值', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new LLMClient(VALID_KEY);
    await client.chat({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: '你好' }],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-reasoner');
  });

  it('占位符 Key 视为未配置，不发起网络请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LLMClient('your_deepseek_api_key_here');

    await expect(
      client.chat({ messages: [{ role: 'user', content: '你好' }] }),
    ).rejects.toThrow('DEEPSEEK_API_KEY is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非 2xx 响应抛出服务端错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, 'Invalid API key')));
    const client = new LLMClient(VALID_KEY);

    await expect(
      client.chat({ messages: [{ role: 'user', content: '你好' }] }),
    ).rejects.toThrow('Invalid API key');
  });
});

describe('LLMClient.chatWithRetry', () => {
  it('失败后重试并最终成功', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new LLMClient(VALID_KEY);
    const result = await client.chatWithRetry(
      { messages: [{ role: 'user', content: '你好' }] },
      { maxRetries: 2, retryDelayMs: 0, timeoutMs: 1000 },
    );

    expect(result.choices[0].message.content).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('重试耗尽后抛错，交由调用方回落', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new LLMClient(VALID_KEY);
    await expect(
      client.chatWithRetry(
        { messages: [{ role: 'user', content: '你好' }] },
        { maxRetries: 1, retryDelayMs: 0, timeoutMs: 1000 },
      ),
    ).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('认证失败等确定性错误不重试，直接抛错', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401, 'Invalid API key'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new LLMClient(VALID_KEY);
    await expect(
      client.chatWithRetry(
        { messages: [{ role: 'user', content: '你好' }] },
        { maxRetries: 3, retryDelayMs: 0, timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ status: 401, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('限流与服务端错误会重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, 'rate limited'))
      .mockResolvedValueOnce(errorResponse(503, 'service unavailable'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new LLMClient(VALID_KEY);
    const result = await client.chatWithRetry(
      { messages: [{ role: 'user', content: '你好' }] },
      { maxRetries: 2, retryDelayMs: 0, timeoutMs: 1000 },
    );

    expect(result.choices[0].message.content).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('超时后中止请求并抛出明确错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );

    const client = new LLMClient(VALID_KEY);
    await expect(
      client.chatWithRetry(
        { messages: [{ role: 'user', content: '你好' }] },
        { maxRetries: 0, timeoutMs: 20 },
      ),
    ).rejects.toThrow('timed out after 20ms');
  });
});

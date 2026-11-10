import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelAdapter } from './model';
import type { EvalSample } from './sample';

function sample(overrides: Partial<EvalSample> = {}): EvalSample {
  return {
    id: 'normal_l1_order',
    category: 'normal',
    tenant: { thresholds: { amountL2Threshold: 5000 } },
    principal: { userId: 'u_eval', role: 'owner' },
    input: { messages: ['给伟业公司下一单 100 个圣诞球，单价 2 块'] },
    fixtures: { customers: [], products: [], orders: [] },
    expect: { decision: 'allow' },
    tags: ['normal'],
    ...overrides,
  };
}

describe('createModelAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined for deterministic mode without touching global env', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'valid-key-that-is-long-enough');
    expect(createModelAdapter(sample(), 'deterministic')).toBeUndefined();
    expect(process.env.DEEPSEEK_API_KEY).toBe('valid-key-that-is-long-enough');
  });

  it('returns mock responses in order and fails when exhausted', async () => {
    const adapter = createModelAdapter(
      sample({ modelResponses: ['{"kind":"chat","reply":"ok"}'] }),
      'mock',
    );
    expect(adapter).toBeDefined();
    const first = await adapter!.chat({ messages: [] });
    expect(first.choices[0].message.content).toContain('"ok"');
    await expect(adapter!.chat({ messages: [] })).rejects.toThrow(/no mock response/);
  });

  it('rejects recorded mode without a directory', () => {
    expect(() => createModelAdapter(sample(), 'recorded')).toThrow(/recording directory/);
  });

  it('reads a recording that stays inside the recorded directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tef-eval-rec-'));
    writeFileSync(
      join(dir, 'normal_l1_order.json'),
      JSON.stringify({
        responses: [
          {
            id: 'rec_1',
            model: 'recorded-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: '{"kind":"chat","reply":"ok"}' }, finish_reason: 'stop' },
            ],
          },
        ],
      }),
    );

    const adapter = createModelAdapter(sample(), 'recorded', dir);
    const response = await adapter!.chat({ messages: [] });
    expect(response.model).toBe('recorded-model');
  });

  it('rejects sample ids that escape the recorded directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tef-eval-rec-'));
    // 绕过 schema 直接构造恶意 id：路径解析必须拒绝读取目录外文件。
    expect(() =>
      createModelAdapter(sample({ id: '../outside' }), 'recorded', dir),
    ).toThrow(/escapes/);
    expect(() =>
      createModelAdapter(sample({ id: '/tmp/outside' }), 'recorded', dir),
    ).toThrow(/escapes/);
  });
});

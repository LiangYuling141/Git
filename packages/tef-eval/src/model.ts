import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { LLMClient, type LLMChatRequest, type LLMChatResponse } from '@lymtrix/tef-runtime';
import type { ModelAdapter } from '@lymtrix/tef-runtime';
import type { EvalSample } from './sample';

export type ModelMode = 'deterministic' | 'mock' | 'recorded' | 'live';

function response(model: string, content: string): LLMChatResponse {
  return {
    id: `mock_${Math.random().toString(36).slice(2)}`,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * 录制文件路径必须落在录制目录内。
 *
 * 样本 schema 已限制 id 字符集，但 `createModelAdapter` 也可能被直接调用
 * （测试、脚本）；这里再做一次路径解析校验，拒绝 `..` 与绝对路径逃逸。
 */
function recordingPath(recordedDir: string, sampleId: string): string {
  const base = resolve(recordedDir);
  const candidate = resolve(base, `${sampleId}.json`);
  const rel = relative(base, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`recorded response path for ${sampleId} escapes ${base}`);
  }
  return candidate;
}

function assertMockResponse(sample: EvalSample, index: number, count: number): string {
  const content = sample.modelResponses?.[index];
  if (content === undefined) {
    throw new Error(`sample ${sample.id} has no mock response for turn ${index} (have ${count})`);
  }
  return content;
}

export function createModelAdapter(
  sample: EvalSample,
  mode: ModelMode,
  recordedDir?: string,
): ModelAdapter | undefined {
  if (mode === 'deterministic') {
    // 环境 Key 的临时关闭由 runE2eSample 负责，避免在纯工厂函数里修改全局状态。
    return undefined;
  }

  if (mode === 'mock') {
    let index = 0;
    return {
      chat: async () => {
        const content = assertMockResponse(sample, index, sample.modelResponses?.length ?? 0);
        index += 1;
        return response('mock-model', content);
      },
    };
  }

  if (mode === 'recorded') {
    if (!recordedDir) throw new Error('recorded mode requires a recording directory');
    const recorded = JSON.parse(readFileSync(recordingPath(recordedDir, sample.id), 'utf8')) as {
      responses: LLMChatResponse[];
    };
    let index = 0;
    return {
      chat: async () => {
        const result = recorded.responses[index];
        if (!result) throw new Error(`recorded response missing for ${sample.id} turn ${index}`);
        index += 1;
        return result;
      },
    };
  }

  const client = new LLMClient();
  const responses: LLMChatResponse[] = [];
  return {
    chat: async (request: LLMChatRequest) => {
      const result = await client.chatWithRetry(request, { maxRetries: 1, timeoutMs: 30000 });
      responses.push(result);
      if (recordedDir) {
        mkdirSync(recordedDir, { recursive: true });
        writeFileSync(
          recordingPath(recordedDir, sample.id),
          `${JSON.stringify({ responses }, null, 2)}\n`,
        );
      }
      return result;
    },
  };
}

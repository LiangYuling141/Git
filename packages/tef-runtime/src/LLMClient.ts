// =============================================================================
// LLM Client — OpenAI-compatible chat completions
// =============================================================================
//
// 默认供应商为 DeepSeek（https://api.deepseek.com/v1）。
// 只发送标准 OpenAI 字段，不包含任何供应商专属参数；更换兼容服务时
// 只需改 DEEPSEEK_API_BASE / DEEPSEEK_MODEL，调用方无需改动。
//
// 重试耗尽后直接抛错，由调用方决定回落策略：
//   - ./intent.ts 回落到确定性规则解析器；
//   - src/agents/* 回落到各自的 regex / 规则校验。

import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'LLMClient');

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatRequest {
  /** 未指定时使用 DEEPSEEK_MODEL，缺省 deepseek-chat */
  model?: string;
  messages: LLMMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface LLMChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 一次模型调用的 token 用量；评测层用于统计成本。 */
export interface TokenUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function toTokenUsage(response: LLMChatResponse): TokenUsage | undefined {
  if (!response.usage) return undefined;
  return {
    model: response.model,
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
  };
}

export interface LLMError {
  error: {
    message: string;
    type?: string;
    code?: string;
  };
}

/**
 * HTTP 层错误。retryable 区分瞬时故障（网络、限流、5xx）与确定性错误
 * （鉴权失败、参数非法），后者重试只会浪费超时预算。
 */
export class LLMHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LLMHttpError';
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export const DEFAULT_DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

/** 占位符、过短的 Key 都视为未配置。 */
function isUsableKey(key: string): boolean {
  return key.length >= 20 && !/^(your|xxx|placeholder|changeme)/i.test(key);
}

/** 供不持有客户端实例的调用方做配置检查。 */
export function isDeepSeekConfigured(): boolean {
  return isUsableKey(process.env.DEEPSEEK_API_KEY ?? '');
}

export class LLMClient {
  private readonly explicitApiKey?: string;

  constructor(apiKey?: string) {
    this.explicitApiKey = apiKey;
  }

  /**
   * 配置在调用时解析，而不是构造时固化：模块加载顺序、运行时注入和测试
   * 都不再影响单例读取到的环境变量。
   */
  private get apiKey(): string {
    return this.explicitApiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
  }

  private get baseUrl(): string {
    return (process.env.DEEPSEEK_API_BASE || DEFAULT_DEEPSEEK_API_BASE).replace(/\/+$/, '');
  }

  private get defaultModel(): string {
    return process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
  }

  isConfigured(): boolean {
    return isUsableKey(this.apiKey);
  }

  getModel(): string {
    return this.defaultModel;
  }

  private getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  async chat(request: LLMChatRequest, signal?: AbortSignal): Promise<LLMChatResponse> {
    if (!this.isConfigured()) {
      throw new Error('DEEPSEEK_API_KEY is not configured');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ ...request, model: request.model || this.defaultModel }),
      signal,
    });

    if (!response.ok) {
      let message = `DeepSeek API error: ${response.status}`;
      try {
        const errorData = await response.json() as LLMError;
        if (errorData.error?.message) message = errorData.error.message;
      } catch {
        // 响应体不是 JSON 时保留状态码信息
      }
      throw new LLMHttpError(message, response.status, isRetryableStatus(response.status));
    }

    return response.json() as Promise<LLMChatResponse>;
  }

  async chatWithRetry(
    request: LLMChatRequest,
    options: {
      maxRetries?: number;
      timeoutMs?: number;
      retryDelayMs?: number;
    } = {},
  ): Promise<LLMChatResponse> {
    const { maxRetries = 3, timeoutMs = 30000, retryDelayMs = 1000 } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        return await this.chat(request, controller.signal);
      } catch (error) {
        if (error instanceof LLMHttpError && !error.retryable) {
          throw error;
        }
        lastError = controller.signal.aborted
          ? new Error(`DeepSeek request timed out after ${timeoutMs}ms`)
          : error as Error;
        logger.warn(`DeepSeek attempt ${attempt + 1}/${maxRetries + 1} failed: ${lastError.message}`);
        if (attempt < maxRetries) {
          await this.delay(retryDelayMs * Math.pow(2, attempt));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error('DeepSeek request failed');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const llmClient = new LLMClient();

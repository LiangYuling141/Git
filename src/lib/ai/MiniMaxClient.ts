// =============================================================================
// MiniMax API Client
// =============================================================================

import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'MiniMaxClient');

export interface MiniMaxMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface MiniMaxChatRequest {
  model: 'MiniMax-M2.7' | 'MiniMax-M2.5';
  messages: MiniMaxMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  bot_setting?: Array<{
    bot_name: string;
    bot_description?: string;
  }>;
}

export interface MiniMaxChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface MiniMaxError {
  error: {
    message: string;
    type: 'invalid_request_error' | 'authentication_error' | 'api_error';
    code?: string;
  };
}

const MINIMAX_API_BASE = 'https://api.minimax.chat/v1';

export class MiniMaxClient {
  private apiKey: string;
  private baseUrl: string;
  private groupId: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.MINIMAX_API_KEY || '';
    this.baseUrl = process.env.MINIMAX_API_BASE || MINIMAX_API_BASE;
    this.groupId = process.env.MINIMAX_GROUP_ID || '';
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    if (this.groupId) {
      headers['MMG-Group-Id'] = this.groupId;
    }
    return headers;
  }

  async chat(request: MiniMaxChatRequest): Promise<MiniMaxChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    // MiniMax API requires bot_setting parameter
    const botSetting = request.bot_setting || [
      {
        bot_name: 'LyMtrix Assistant',
        bot_description: 'AI-powered CRM assistant for small business management'
      }
    ];

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ ...request, bot_setting: botSetting }),
    });

    if (!response.ok) {
      const errorData = await response.json() as MiniMaxError;
      throw new Error(errorData.error?.message || `MiniMax API error: ${response.status}`);
    }

    return response.json() as Promise<MiniMaxChatResponse>;
  }

  async chatWithRetry(
    request: MiniMaxChatRequest,
    options: {
      maxRetries?: number;
      timeoutMs?: number;
      retryDelayMs?: number;
    } = {}
  ): Promise<MiniMaxChatResponse> {
    const { maxRetries = 3, timeoutMs = 30000, retryDelayMs = 1000 } = options;

    return this.executeWithFallback(request, { maxRetries, timeoutMs, retryDelayMs });
  }

  private async executeWithFallback(
    request: MiniMaxChatRequest,
    options: { maxRetries: number; timeoutMs: number; retryDelayMs: number }
  ): Promise<MiniMaxChatResponse> {
    const fallbackChain: Array<{ model: string; provider: string }> = [
      { model: 'MiniMax-M2.7', provider: 'minimax' },
      { model: 'MiniMax-M2.5', provider: 'minimax' },
      { model: 'doubao-pro-32k', provider: 'doubao' },
    ];

    let lastError: Error | null = null;

    for (let level = 0; level < fallbackChain.length; level++) {
      const fallback = fallbackChain[level];
      
      try {
        const fallbackRequest = { ...request, model: fallback.model as 'MiniMax-M2.7' | 'MiniMax-M2.5' };
        
        for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
          try {
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`Timeout at ${fallback.provider}`)), options.timeoutMs);
            });

            const responsePromise = this.chat(fallbackRequest);
            const response = await Promise.race([responsePromise, timeoutPromise]);
            logger.debug(`Fallback success at level ${level + 1}: ${fallback.model}`);
            return response;
          } catch (error) {
            lastError = error as Error;
            if (attempt < options.maxRetries) {
              await this.delay(options.retryDelayMs * Math.pow(2, attempt));
            }
          }
        }
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Fallback level ${level + 1} (${fallback.model}) failed: ${lastError.message}`);
      }
    }

    logger.warn('All LLM levels failed, using rule engine fallback');
    return this.ruleEngineFallback(request);
  }

  private ruleEngineFallback(request: MiniMaxChatRequest): MiniMaxChatResponse {
    return {
      id: 'rule-fallback-' + Date.now(),
      model: 'rule-engine',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '{"status":"fallback","reason":"All AI services unavailable"}' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const miniMaxClient = new MiniMaxClient();

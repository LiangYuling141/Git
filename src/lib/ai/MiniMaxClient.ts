// =============================================================================
// MiniMax API Client
// =============================================================================

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

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
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

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
        });

        const responsePromise = this.chat(request);
        return await Promise.race([responsePromise, timeoutPromise]);
      } catch (error) {
        lastError = error as Error;

        if (attempt < maxRetries) {
          await this.delay(retryDelayMs * Math.pow(2, attempt));
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const miniMaxClient = new MiniMaxClient();

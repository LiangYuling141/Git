// =============================================================================
// Rate Limit Hook - Prevents abuse through frequency control
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';
import { checkRateLimit } from '@/lib/rate-limit';

// -----------------------------------------------------------------------------
// Rate Limit Configuration
// -----------------------------------------------------------------------------

interface RateLimitConfig {
  limit: number;           // requests per minute
  windowSecs: number;      // window in seconds
}

const DEFAULT_CONFIG: RateLimitConfig = {
  limit: 100,              // 100 requests per minute for normal API
  windowSecs: 60,
};

export class RateLimitHook implements Hook {
  name = 'rate_limit';
  type: HookType = 'pre_processing';
  priority = 90;
  enabledByDefault = true;

  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(context: HookContext): Promise<HookResult> {
    const userId = context.session.userId || 'anonymous';

    // Use session metadata to check if this is an agent chat interaction
    // Agent chats have lower limits (10/min) vs normal API (100/min)
    const isAgentChat = context.session.metadata?.isAgentChat === true;
    const limit = isAgentChat ? 10 : this.config.limit;

    const result = await checkRateLimit(
      `ratelimit:${userId}`,
      limit,
      this.config.windowSecs
    );

    if (!result.allowed) {
      return {
        status: 'block',
        message: isAgentChat
          ? 'Agent chat rate limit exceeded. Please wait before sending more messages.'
          : 'API rate limit exceeded. Please try again later.',
        allowRetry: true,
      };
    }

    return { status: 'allow', allowRetry: false };
  }
}

export const rateLimitHook = new RateLimitHook();
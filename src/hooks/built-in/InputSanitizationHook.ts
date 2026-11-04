// =============================================================================
// Input Sanitization Hook - Blocks injection attempts in user input
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

const SQL_INJECTION = /(\bunion\s+select\b|\bdrop\s+(table|database)\b|;\s*--|\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+)/i;
const COMMAND_INJECTION = /(?:[;&|`]|\$\(|\|\|)\s*(rm|cat|curl|wget|bash|sh|nc|chmod|chown)\b/i;
const PROMPT_INJECTION = /(ignore\s+(all\s+)?(previous|prior)\s+instructions|disregard\s+(all\s+)?(previous|prior)\s+instructions|<\|system\|>|system\s*prompt)/i;

export class InputSanitizationHook implements Hook {
  name = 'input_sanitization';
  type: HookType = 'pre_processing';
  priority = 100;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const input = context.userInput;
    if (!input) {
      return { status: 'allow', allowRetry: false };
    }

    if (SQL_INJECTION.test(input)) {
      return {
        status: 'block',
        message: '检测到可疑的 SQL 注入模式',
        allowRetry: true,
      };
    }

    if (COMMAND_INJECTION.test(input)) {
      return {
        status: 'block',
        message: '检测到可疑的命令注入模式',
        allowRetry: true,
      };
    }

    if (PROMPT_INJECTION.test(input)) {
      return {
        status: 'block',
        message: '检测到可疑的 Prompt 注入',
        allowRetry: true,
      };
    }

    return { status: 'allow', allowRetry: false };
  }
}

export const inputSanitizationHook = new InputSanitizationHook();

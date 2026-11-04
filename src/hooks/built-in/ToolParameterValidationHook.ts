// =============================================================================
// Tool Parameter Validation Hook - Validates tool call parameters before execution
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

type ParameterRule = RegExp | ((value: unknown) => boolean) | readonly unknown[];

interface ToolRule {
  required: string[];
  optional: string[];
  validation: Record<string, ParameterRule>;
}

const TOOL_RULES: Record<string, ToolRule> = {
  'customer.create': {
    required: ['name', 'phone'],
    optional: ['email', 'address', 'tax_id'],
    validation: {
      phone: /^(1[3-9]\d{9})$/,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      tax_id: /^[A-Z0-9]{15,20}$/i,
    },
  },
  'order.create': {
    required: ['customer_id', 'items', 'total_amount'],
    optional: ['discount', 'remark'],
    validation: {
      total_amount: (value) => typeof value === 'number' && value >= 0 && value <= 10000000,
      discount: (value) => typeof value === 'number' && value >= 0 && value <= 1,
    },
  },
  'payment.create': {
    required: ['order_id', 'amount', 'method'],
    optional: ['remark'],
    validation: {
      amount: (value) => typeof value === 'number' && value > 0 && value <= 5000000,
      method: ['cash', 'transfer', 'credit', 'wechat', 'alipay'],
    },
  },
};

export class ToolParameterValidationHook implements Hook {
  name = 'tool_parameter_validation';
  type: HookType = 'pre_tool';
  priority = 100;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const toolCall = context.toolCall;
    if (!toolCall) {
      return { status: 'allow', allowRetry: false };
    }

    const rules = TOOL_RULES[toolCall.toolName];
    if (!rules) {
      return { status: 'allow', allowRetry: false };
    }

    const errors: string[] = [];
    const params = toolCall.parameters;

    for (const field of rules.required) {
      if (params[field] === undefined || params[field] === null) {
        errors.push(`缺少必填参数: ${field}`);
      }
    }

    for (const [field, rule] of Object.entries(rules.validation)) {
      const value = params[field];
      if (value === undefined) continue;

      if (typeof rule === 'function') {
        if (!rule(value)) {
          errors.push(`参数 ${field} 验证失败`);
        }
      } else if (rule instanceof RegExp) {
        if (!rule.test(String(value))) {
          errors.push(`参数 ${field} 格式错误`);
        }
      } else if (Array.isArray(rule)) {
        if (!rule.includes(value)) {
          errors.push(`参数 ${field} 必须是: ${rule.join(', ')}`);
        }
      }
    }

    if (errors.length > 0) {
      return {
        status: 'block',
        message: `工具参数验证失败:\n${errors.join('\n')}`,
        allowRetry: true,
      };
    }

    return { status: 'allow', allowRetry: false };
  }
}

export const toolParameterValidationHook = new ToolParameterValidationHook();

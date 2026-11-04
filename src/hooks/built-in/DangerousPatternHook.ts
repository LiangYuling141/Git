// =============================================================================
// Dangerous Pattern Hook - Blocks destructive and privilege-escalating content
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

interface DangerousPattern {
  pattern: RegExp;
  message: string;
}

const DESTRUCTIVE: DangerousPattern[] = [
  { pattern: /rm\s+-rf/i, message: '检测到递归删除操作' },
  { pattern: /drop\s+(table|database)/i, message: '检测到删除表/数据库操作' },
  { pattern: /truncate\s+\w+/i, message: '检测到清空表操作' },
  { pattern: /delete\s+from\s+\w+\s*(;|$)/im, message: '检测到无条件的删除操作' },
  { pattern: /shutdown\s+/i, message: '检测到关闭系统命令' },
];

const PRIVILEGE_ESCALATION: DangerousPattern[] = [
  { pattern: /chmod\s+777/i, message: '检测到极不安全的权限设置' },
  { pattern: /chown\s+\w+:\w+\s+\//i, message: '检测到修改根目录所有权' },
  { pattern: /sudo\s+without/i, message: '检测到尝试绕过 sudo' },
];

const DATA_EXFILTRATION: DangerousPattern[] = [
  { pattern: /\bexec\s*\(\s*\$_(GET|POST|REQUEST)/i, message: '检测到可疑的代码执行' },
  { pattern: /base64_decode\s*\(/i, message: '检测到 Base64 解码操作' },
  { pattern: /concat\s*\(.*from/i, message: '检测到可疑的数据拼接查询' },
];

const BYPASS: DangerousPattern[] = [
  { pattern: /--\s*$/m, message: '检测到 SQL 注释注入' },
  { pattern: /\/\*.*\*\//m, message: '检测到块注释注入' },
  { pattern: /(\bor\b|')\s*1\s*=\s*1/i, message: '检测到永真条件注入' },
];

export class DangerousPatternHook implements Hook {
  name = 'dangerous_pattern';
  type: HookType = 'stop';
  priority = 100;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const content = context.aiOutput || context.operation?.description || '';
    if (!content) {
      return { status: 'allow', allowRetry: false };
    }

    for (const rule of [...DESTRUCTIVE, ...PRIVILEGE_ESCALATION]) {
      if (rule.pattern.test(content)) {
        return {
          status: 'block',
          message: rule.message,
          allowRetry: true,
        };
      }
    }

    const warnings: string[] = [];
    for (const rule of [...DATA_EXFILTRATION, ...BYPASS]) {
      if (rule.pattern.test(content)) {
        warnings.push(rule.message);
      }
    }

    if (warnings.length > 0) {
      return {
        status: 'warn',
        message: '检测到可疑内容',
        warnings,
        allowRetry: false,
      };
    }

    return { status: 'allow', allowRetry: false };
  }
}

export const dangerousPatternHook = new DangerousPatternHook();

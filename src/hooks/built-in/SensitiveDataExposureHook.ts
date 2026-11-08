// =============================================================================
// Sensitive Data Exposure Hook - Masks sensitive values in AI output
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

interface SensitivePattern {
  pattern: RegExp;
  name: string;
  category: string;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { pattern: /\b\d{16,19}\b/, name: '银行卡号', category: 'financial' },
  { pattern: /\b\d{15,18}\b/, name: '身份证号', category: 'id' },
  { pattern: /password\s*[=:]\s*\S+/i, name: '密码明文', category: 'credential' },
  { pattern: /api[_-]?key\s*[=:]\s*\S+/i, name: 'API Key', category: 'credential' },
  { pattern: /secret\s*[=:]\s*\S+/i, name: '密钥', category: 'credential' },
  { pattern: /token\s*[=:]\s*\S+/i, name: 'Token', category: 'credential' },
];

export class SensitiveDataExposureHook implements Hook {
  name = 'sensitive_data_exposure';
  type: HookType = 'stop';
  priority = 95;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const content = context.aiOutput;
    if (!content) {
      return { status: 'allow', allowRetry: false };
    }

    for (const rule of SENSITIVE_PATTERNS) {
      if (!rule.pattern.test(content)) {
        continue;
      }

      const masked = this.maskSensitiveData(content, rule.pattern);
      context.aiOutput = masked;

      return {
        status: 'modify',
        message: `检测到 ${rule.name}，已自动脱敏`,
        modifiedData: { aiOutput: masked },
        warnings: [`类别: ${rule.category}`],
        allowRetry: false,
      };
    }

    return { status: 'allow', allowRetry: false };
  }

  private maskSensitiveData(content: string, pattern: RegExp): string {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);

    return content.replace(globalPattern, (match) => {
      if (match.length <= 4) return '****';
      return match.slice(0, 2) + '*'.repeat(match.length - 4) + match.slice(-2);
    });
  }
}

export const sensitiveDataExposureHook = new SensitiveDataExposureHook();

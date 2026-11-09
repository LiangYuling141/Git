// =============================================================================
// Sub Agent 2 - Security Permission Validator using DeepSeek
// =============================================================================

import { llmClient, isDeepSeekConfigured, type LLMMessage } from '@/lib/ai/LLMClient';
import type { Operation, Session } from '@/types';
import type { AgentVoter } from '@/voting';
import { parseValidationResult, type ValidationResult } from '@/lib/ai/IAgentKernel';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SECURITY, 'SubAgent2');

const SYSTEM_PROMPT = `You are a Security Permission Validator Agent for the LyMatrix TEF reference implementation (CRM-ERP).
Your role is to check if operations violate security rules or permission boundaries.

SECURITY RULES:
1. Delete operations on critical entities require special permission
2. Amount limits: Single operation > 5,000,000 requires approval
3. High-risk operations (batch deletes, bulk updates) require verification
4. Operations outside working hours (9:00-18:00 weekdays) may require extra verification
5. Cross-tenant operations are strictly prohibited

Respond ONLY with JSON in this format:
{
  "passed": true/false,
  "reason": "brief explanation if rejected",
  "riskPoints": ["list of risk points if any"]
}`;

const USER_PROMPT_TEMPLATE = `Check security rules for this operation:
- Operation Type: {operationType}
- Entity: {entity}
- Amount: {amount}
- Description: {description}

User Context:
- User ID: {userId}
- Risk Level: {riskLevel}`;

export class SubAgent2 implements AgentVoter {
  role = 'sub2' as const;
  private reason = '';
  private lastResult: ValidationResult = { passed: true };

  async vote(operation: Operation, session: Session): Promise<'approve' | 'reject'> {
    this.reason = '';
    this.lastResult = { passed: true };

    if (!isDeepSeekConfigured()) {
      logger.warn('DEEPSEEK_API_KEY not set, using fallback validation');
      return this.fallbackValidation(operation, session);
    }

    try {
      const result = await this.validateWithAI(operation, session);
      this.lastResult = result;
      return result.passed ? 'approve' : 'reject';
    } catch (error) {
      logger.error('SubAgent2 validation error', error as Error);
      this.reason = 'Validation service unavailable, using fallback';
      return this.fallbackValidation(operation, session);
    }
  }

  private async validateWithAI(operation: Operation, session: Session): Promise<ValidationResult> {
    const userPrompt = USER_PROMPT_TEMPLATE
      .replace('{operationType}', operation.type)
      .replace('{entity}', operation.entity)
      .replace('{amount}', String(operation.amount || 0))
      .replace('{description}', operation.description)
      .replace('{userId}', session.userId)
      .replace('{riskLevel}', session.riskLevel);

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    const response = await llmClient.chatWithRetry(
      {
        messages,
        temperature: 0.1,
        max_tokens: 500,
      },
      {
        maxRetries: 2,
        timeoutMs: 15000,
      }
    );

    const content = response.choices[0]?.message?.content || '{}';

    try {
      const parsed = parseValidationResult(content);
      this.reason = parsed.reason || '';
      return parsed;
    } catch {
      return { passed: false, reason: 'AI response failed schema validation' };
    }
  }

  private fallbackValidation(operation: Operation, session: Session): 'approve' | 'reject' {
    if (operation.type === 'delete') {
      if (operation.entity === 'customer' || operation.entity === 'order') {
        this.reason = 'Delete operation on critical entity requires special permission';
        this.lastResult = { passed: false, reason: this.reason };
        return 'reject';
      }
    }

    if (operation.amount !== undefined && operation.amount > 5000000) {
      this.reason = 'Amount exceeds single operation limit (5,000,000)';
      this.lastResult = { passed: false, reason: this.reason };
      return 'reject';
    }

    return 'approve';
  }

  getReason(): string {
    return this.reason;
  }

  getLastResult(): ValidationResult {
    return this.lastResult;
  }
}

export const subAgent2 = new SubAgent2();

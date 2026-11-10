// =============================================================================
// Sub Agent 1 - Business Rule Validator using DeepSeek
// =============================================================================

import { llmClient, isDeepSeekConfigured, type LLMMessage } from '@/lib/ai/LLMClient';
import type { Operation, Session } from '@/types';
import type { AgentVoter } from '@/voting';
import { parseValidationResult, type ValidationResult } from '@/lib/ai/IAgentKernel';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'SubAgent1');

const SYSTEM_PROMPT = `You are a Business Rule Validator Agent for the LyMtrix-TEF reference implementation (CRM-ERP).
Your role is to validate business rules for operations.

VALIDATION RULES:
1. Customer validation: Check if customer exists and is active
2. Order validation: Check if order amount is valid (not negative), inventory availability
3. Price validation: Verify pricing rules and discount limits
4. Credit validation: Check credit limits before accepting large orders

Respond ONLY with JSON in this format:
{
  "passed": true/false,
  "reason": "brief explanation if rejected",
  "riskPoints": ["list of risk points if any"]
}`;

const USER_PROMPT_TEMPLATE = `Validate this operation:
- Operation Type: {operationType}
- Entity: {entity}
- Amount: {amount}
- Fields: {fields}
- Description: {description}

Customer Context:
- Customer ID: {customerId}
- Credit Limit: {creditLimit}
- Is High Risk: {isHighRisk}
- Monthly Transaction: {monthlyTransaction}`;

export class SubAgent1 implements AgentVoter {
  role = 'sub1' as const;
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
      logger.error('SubAgent1 validation error', error as Error);
      this.reason = 'Validation service unavailable, using fallback';
      return this.fallbackValidation(operation, session);
    }
  }

  private async validateWithAI(operation: Operation, session: Session): Promise<ValidationResult> {
    const customer = (session.metadata as Record<string, unknown>)?.customer as { id?: string; creditLimit?: number; isHighRisk?: boolean; monthlyTransaction?: number } | undefined;

    const userPrompt = USER_PROMPT_TEMPLATE
      .replace('{operationType}', operation.type)
      .replace('{entity}', operation.entity)
      .replace('{amount}', String(operation.amount || 0))
      .replace('{fields}', (operation.fields || []).join(', '))
      .replace('{description}', operation.description)
      .replace('{customerId}', customer?.id || 'unknown')
      .replace('{creditLimit}', String(customer?.creditLimit || 0))
      .replace('{isHighRisk}', String(customer?.isHighRisk || false))
      .replace('{monthlyTransaction}', String(customer?.monthlyTransaction || 0));

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
    if (operation.entity === 'order' && operation.amount !== undefined) {
      if (operation.amount < 0) {
        this.reason = 'Order amount cannot be negative';
        this.lastResult = { passed: false, reason: this.reason };
        return 'reject';
      }
    }

    if (operation.entity === 'customer' && operation.type === 'delete') {
      this.reason = 'Customer deletion requires special approval';
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

export const subAgent1 = new SubAgent1();

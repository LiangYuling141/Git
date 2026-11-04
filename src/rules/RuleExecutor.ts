// =============================================================================
// Rule Executor - Evaluates declarative rule conditions
// =============================================================================

import type { RuleCondition, RuleContext, RuleDefinition, RuleResult } from './types';
import { validateInternationalTradeRule } from './plugins/InternationalTradePlugin';

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function evaluateCondition(condition: RuleCondition, data: Record<string, unknown>): boolean {
  const value = data[condition.field];

  if (condition.operator !== 'required' && value === undefined) {
    return true;
  }

  switch (condition.operator) {
    case 'required':
      return !isBlank(value);

    case 'equals':
      return value === condition.value;

    case 'gt': {
      const actual = toNumber(value);
      return Number.isFinite(actual) && actual > toNumber(condition.value);
    }

    case 'gte': {
      const actual = toNumber(value);
      return Number.isFinite(actual) && actual >= toNumber(condition.value);
    }

    case 'lt': {
      const actual = toNumber(value);
      return Number.isFinite(actual) && actual < toNumber(condition.value);
    }

    case 'lte': {
      const actual = toNumber(value);
      return Number.isFinite(actual) && actual <= toNumber(condition.value);
    }

    case 'min': {
      const actual = Array.isArray(value) ? value.length : toNumber(value);
      return Number.isFinite(actual) && actual >= toNumber(condition.value);
    }

    case 'max': {
      const actual = Array.isArray(value) ? value.length : toNumber(value);
      return Number.isFinite(actual) && actual <= toNumber(condition.value);
    }

    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(value);

    case 'pattern': {
      if (!condition.pattern) return true;
      return typeof value === 'string' && new RegExp(condition.pattern).test(value);
    }

    case 'custom':
      return true;

    default:
      return true;
  }
}

export class RuleExecutor {
  async execute(rule: RuleDefinition, context: RuleContext): Promise<RuleResult> {
    const violations: string[] = [];

    for (const condition of rule.conditions) {
      if (condition.operator === 'custom') continue;
      if (!evaluateCondition(condition, context.data)) {
        violations.push(condition.message);
      }
    }

    violations.push(...validateInternationalTradeRule(rule.ruleId, context));

    return {
      passed: violations.length === 0,
      ruleId: rule.ruleId,
      ruleName: rule.name,
      errorLevel: rule.errorLevel,
      violations,
    };
  }
}

export const ruleExecutor = new RuleExecutor();

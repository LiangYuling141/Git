// =============================================================================
// Rule System Types
// =============================================================================

export type RuleOperator =
  | 'required'
  | 'equals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'min'
  | 'max'
  | 'in'
  | 'pattern'
  | 'custom';

export interface RuleCondition {
  field: string;
  operator: RuleOperator;
  value?: unknown;
  pattern?: string;
  message: string;
}

export interface RuleDefinition {
  ruleId: string;
  name: string;
  description: string;
  entity: string;
  operation: string;
  enabled: boolean;
  priority: number;
  errorLevel: 'reject' | 'warn';
  conditions: RuleCondition[];
  tags?: string[];
}

export interface RuleContext {
  entity: string;
  operation: string;
  data: Record<string, unknown>;
}

export interface RuleResult {
  passed: boolean;
  ruleId: string;
  ruleName: string;
  errorLevel: 'reject' | 'warn';
  violations: string[];
}

export interface BatchRuleResult {
  passed: boolean;
  results: RuleResult[];
  hasRejections: boolean;
  hasWarnings: boolean;
}

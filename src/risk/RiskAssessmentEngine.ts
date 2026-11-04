// =============================================================================
// Risk Assessment Engine - Deterministic L0 / L1 / L2 / Block classification
// See docs/technical/14-unified-architecture.md §3
// =============================================================================

import type { Customer, Operation, RiskLevel, Session } from '@/types';

export type RiskDecision = 'allow' | 'confirm' | 'block';
export type RiskOutcome = RiskLevel | 'Block';

export interface RiskAssessmentResult {
  level: RiskOutcome;
  riskLevel: RiskLevel;
  decision: RiskDecision;
  requiresConfirmation: boolean;
  reasons: string[];
}

const VALID_ENTITIES = new Set(['customer', 'order', 'payment']);
const VALID_OPERATIONS = new Set(['query', 'create', 'update', 'delete']);

const SENSITIVE_FIELDS = new Set([
  'creditLimit',
  'credit_limit',
  'creditLine',
  'credit_line',
  'price',
  'cost',
  'discount',
]);

const DEFAULT_THRESHOLD = 10000;

export class RiskAssessmentEngine {
  evaluateRiskLevel(
    operation: Operation,
    customer: Customer | undefined,
    session: Session
  ): RiskAssessmentResult {
    const reasons: string[] = [];
    const threshold = this.getThreshold(session);

    // 1. Block conditions take precedence over everything else
    if (!VALID_ENTITIES.has(operation.entity)) {
      return this.block(`Unknown entity: ${operation.entity}`);
    }
    if (!VALID_OPERATIONS.has(operation.type)) {
      return this.block(`Unknown operation type: ${operation.type}`);
    }
    if (operation.amount !== undefined && (!Number.isFinite(operation.amount) || operation.amount < 0)) {
      return this.block(`Invalid amount: ${operation.amount}`);
    }

    // 2. Queries are always L0
    if (operation.type === 'query') {
      return this.result('L0', ['Read-only query']);
    }

    // 3. Amount above tenant threshold
    if (operation.amount !== undefined && operation.amount > threshold) {
      reasons.push(`Amount ${operation.amount} exceeds threshold ${threshold}`);
    }

    // 4. Sensitive fields
    const sensitiveField = operation.fields?.find((field) => SENSITIVE_FIELDS.has(field));
    if (sensitiveField) {
      reasons.push(`Sensitive field: ${sensitiveField}`);
    }

    // 5. High-risk customer
    const effectiveCustomer = customer || this.getCustomerFromSession(session);
    if (effectiveCustomer?.isHighRisk) {
      reasons.push('Customer is marked high risk');
    }

    // 6. Deletes always require confirmation
    if (operation.type === 'delete') {
      reasons.push('Delete operation');
    }

    if (reasons.length > 0) {
      return this.result('L2', reasons);
    }

    return this.result('L1', ['Low-risk write']);
  }

  private getThreshold(session: Session): number {
    const configured = session.metadata?.riskThreshold;
    return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_THRESHOLD;
  }

  private getCustomerFromSession(session: Session): Customer | undefined {
    const customer = session.metadata?.customer;
    return customer && typeof customer === 'object' ? (customer as Customer) : undefined;
  }

  private block(reason: string): RiskAssessmentResult {
    return {
      level: 'Block',
      riskLevel: 'L2',
      decision: 'block',
      requiresConfirmation: false,
      reasons: [reason],
    };
  }

  private result(level: RiskLevel, reasons: string[]): RiskAssessmentResult {
    return {
      level,
      riskLevel: level,
      decision: level === 'L2' ? 'confirm' : 'allow',
      requiresConfirmation: level === 'L2',
      reasons,
    };
  }
}

export const riskAssessmentEngine = new RiskAssessmentEngine();

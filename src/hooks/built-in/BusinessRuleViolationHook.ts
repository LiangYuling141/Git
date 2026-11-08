// =============================================================================
// Business Rule Violation Hook - Blocks operations violating core business rules
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';
import type { Operation } from '@/types';

export class BusinessRuleViolationHook implements Hook {
  name = 'business_rule_violation';
  type: HookType = 'stop';
  priority = 80;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const operation = context.operation;
    if (!operation) {
      return { status: 'allow', allowRetry: false };
    }

    const violations: string[] = [];
    const amount = operation.amount ?? 0;
    const customer = context.customer;

    if (this.isCreditLimitChange(operation) && customer) {
      if (amount > customer.creditLimit * 2) {
        violations.push('信用额度调整超过当前额度的 200%');
      }
      if (amount > 500000) {
        violations.push('单次信用额度调整超过 50 万');
      }
    }

    if (this.isPriceModification(operation) && !operation.reason && context.riskLevel === 'L2') {
      violations.push('价格修改必须提供原因');
    }

    if (customer?.isHighRisk) {
      if (operation.type === 'delete') {
        violations.push('高风险客户不允许删除操作');
      }
      if (amount > 10000) {
        violations.push('高风险客户单笔操作金额限制为 1 万');
      }
    }

    if (violations.length > 0) {
      return {
        status: 'block',
        message: `业务规则违规:\n${violations.map((v) => `- ${v}`).join('\n')}`,
        warnings: violations,
        allowRetry: true,
      };
    }

    return { status: 'allow', allowRetry: false };
  }

  private isCreditLimitChange(operation: Operation): boolean {
    return (
      operation.entity === 'customer' &&
      (operation.fields?.some((field) => ['credit_limit', 'credit_line', 'creditLimit', 'creditLine'].includes(field)) ?? false)
    );
  }

  private isPriceModification(operation: Operation): boolean {
    return (
      operation.entity === 'order' &&
      (operation.fields?.some((field) => ['price', 'discount', 'amount', 'total_amount'].includes(field)) ?? false)
    );
  }
}

export const businessRuleViolationHook = new BusinessRuleViolationHook();

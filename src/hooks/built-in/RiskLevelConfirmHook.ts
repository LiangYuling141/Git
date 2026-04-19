// =============================================================================
// Risk Level Confirmation Hook - Confirms risk level is correct at pre_agent phase
// Validates the risk assessment output before voting
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

export class RiskLevelConfirmHook implements Hook {
  name = 'risk_level_confirm';
  type: HookType = 'pre_agent';
  priority = 100;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const operation = context.operation;
    const riskLevel = context.riskLevel;
    const warnings: string[] = [];

    if (!operation) {
      return { status: 'allow', allowRetry: false };
    }

    // L0 check: query operations with no amount should be L0
    if (operation.type === 'query') {
      if (riskLevel && riskLevel !== 'L0') {
        warnings.push(`Query operation incorrectly assessed as ${riskLevel}, should be L0`);
      }
      if (warnings.length > 0) {
        return {
          status: 'warn',
          message: 'Risk level mismatch detected',
          warnings,
          allowRetry: false,
        };
      }
      return { status: 'allow', allowRetry: false };
    }

    // L1/L2 validation: check if risk level matches operation characteristics
    if (!riskLevel || (riskLevel !== 'L0' && riskLevel !== 'L1' && riskLevel !== 'L2')) {
      return {
        status: 'block',
        message: `Invalid risk level: ${riskLevel}`,
        allowRetry: true,
      };
    }

    // Validate L2 conditions
    if (riskLevel === 'L2') {
      const isHighAmount = operation.amount !== undefined && operation.amount > 10000;
      const isDelete = operation.type === 'delete';
      const isSensitiveField = operation.fields?.some((f) =>
        ['price', 'cost', 'discount', 'credit_limit', 'credit_line'].includes(f)
      );

      if (!isHighAmount && !isDelete && !isSensitiveField) {
        warnings.push(
          `Operation assessed as L2 but no clear L2 trigger: amount=${operation.amount}, type=${operation.type}`
        );
      }
    }

    // Validate L1 conditions
    if (riskLevel === 'L1') {
      const isHighAmount = operation.amount !== undefined && operation.amount > 10000;
      const isDelete = operation.type === 'delete';

      if (isHighAmount) {
        warnings.push(
          `Operation assessed as L1 but amount ${operation.amount} exceeds L1 threshold (10,000), should be L2`
        );
      }
      if (isDelete) {
        warnings.push(
          `Delete operations should be L2, but assessed as L1`
        );
      }
    }

    if (warnings.length > 0) {
      return {
        status: 'warn',
        message: 'Risk level may need review',
        warnings,
        allowRetry: false,
      };
    }

    return { status: 'allow', allowRetry: false };
  }
}

export const riskLevelConfirmHook = new RiskLevelConfirmHook();

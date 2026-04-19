// =============================================================================
// Hook System Initialization - Register all built-in hooks
// =============================================================================

import { getHookEngine } from './HookEngine';
import { inputSanitizationHook } from './built-in/InputSanitizationHook';
import { rateLimitHook } from './built-in/RateLimitHook';
import { dangerousPatternHook } from './built-in/DangerousPatternHook';
import { sensitiveDataExposureHook } from './built-in/SensitiveDataExposureHook';
import { businessRuleViolationHook } from './built-in/BusinessRuleViolationHook';
import { toolParameterValidationHook } from './built-in/ToolParameterValidationHook';
import { executionResultValidationHook } from './built-in/ExecutionResultValidationHook';
import { riskLevelConfirmHook } from './built-in/RiskLevelConfirmHook';
import { permissionCheckHook } from './built-in/PermissionCheckHook';
import { operationPreviewHook } from './built-in/OperationPreviewHook';
import { auditLogHook } from './built-in/AuditLogHook';
import type { Hook } from './types';

const builtInHooks: Hook[] = [
  inputSanitizationHook,
  rateLimitHook,
  dangerousPatternHook,
  sensitiveDataExposureHook,
  businessRuleViolationHook,
  toolParameterValidationHook,
  executionResultValidationHook,
  riskLevelConfirmHook,
  permissionCheckHook,
  operationPreviewHook,
  auditLogHook,
];

export function initializeHooks(): void {
  const engine = getHookEngine();

  for (const hook of builtInHooks) {
    engine.register(hook);
    console.log(`[Hooks] Registered: ${hook.name} (${hook.type}, priority ${hook.priority})`);
  }

  console.log(`[Hooks] Initialized ${builtInHooks.length} built-in hooks`);
}

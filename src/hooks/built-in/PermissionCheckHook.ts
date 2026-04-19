// =============================================================================
// Permission Check Hook - Validates user has required permissions at pre_agent phase
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

interface PermissionRule {
  operation: string;
  entity: string;
  requiredPermission: string;
}

const PERMISSION_RULES: PermissionRule[] = [
  { operation: 'query', entity: 'customer', requiredPermission: 'customer:read' },
  { operation: 'query', entity: 'order', requiredPermission: 'order:read' },
  { operation: 'query', entity: 'payment', requiredPermission: 'payment:read' },
  { operation: 'create', entity: 'customer', requiredPermission: 'customer:write' },
  { operation: 'create', entity: 'order', requiredPermission: 'order:write' },
  { operation: 'create', entity: 'payment', requiredPermission: 'payment:write' },
  { operation: 'update', entity: 'customer', requiredPermission: 'customer:write' },
  { operation: 'update', entity: 'order', requiredPermission: 'order:write' },
  { operation: 'update', entity: 'payment', requiredPermission: 'payment:write' },
  { operation: 'delete', entity: 'customer', requiredPermission: 'customer:delete' },
  { operation: 'delete', entity: 'order', requiredPermission: 'order:delete' },
  { operation: 'delete', entity: 'payment', requiredPermission: 'payment:delete' },
];

export class PermissionCheckHook implements Hook {
  name = 'permission_check';
  type: HookType = 'pre_agent';
  priority = 90;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const operation = context.operation;
    const session = context.session;

    if (!operation) {
      return { status: 'allow', allowRetry: false };
    }

    // Find matching permission rule
    const rule = PERMISSION_RULES.find(
      (r) => r.operation === operation.type && r.entity === operation.entity
    );

    if (!rule) {
      // Unknown operation type - allow but log warning
      return {
        status: 'warn',
        message: `No permission rule found for ${operation.type} on ${operation.entity}`,
        warnings: [`Unknown operation: ${operation.type} ${operation.entity}`],
        allowRetry: false,
      };
    }

    // Check if user has required permission
    const userPermissions = this.getUserPermissions(session.userId);
    const hasPermission = userPermissions.includes(rule.requiredPermission) ||
                         userPermissions.includes('*') ||
                         userPermissions.includes('admin');

    if (!hasPermission) {
      return {
        status: 'block',
        message: `Permission denied: requires "${rule.requiredPermission}"`,
        allowRetry: false,
      };
    }

    // Check entity-specific permissions
    if (operation.entity === 'customer' && operation.id) {
      if (!this.canAccessCustomer(session.userId, operation.id)) {
        return {
          status: 'block',
          message: 'You do not have permission to access this customer',
          allowRetry: false,
        };
      }
    }

    return { status: 'allow', allowRetry: false };
  }

  private getUserPermissions(userId: string): string[] {
    // TODO: In production, fetch from database/session
    // For MVP, return default permissions based on userId
    if (userId === 'admin' || userId === 'demo-user') {
      return ['*', 'admin'];
    }
    // Default read-only permissions for demo
    return ['customer:read', 'order:read', 'payment:read'];
  }

  private canAccessCustomer(userId: string, customerId: string): boolean {
    // TODO: Implement tenant isolation
    // For MVP, allow access to all customers
    return true;
  }
}

export const permissionCheckHook = new PermissionCheckHook();

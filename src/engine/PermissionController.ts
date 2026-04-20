// =============================================================================
// Permission Controller - Global permission management with role-based access
// =============================================================================

import { prisma } from '@/lib/prisma';
import type { Operation } from '@/types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SECURITY, 'PermissionController');

// Role definitions
type UserRole = 'super_admin' | 'admin' | 'manager' | 'user' | 'viewer';

interface Permission {
  allowed: boolean;
  reason?: string;
}

// Permission matrix by role and entity/operation
const PERMISSION_MATRIX: Record<UserRole, Record<string, Permission>> = {
  super_admin: {
    '*': { allowed: true },
  },
  admin: {
    'customer:*': { allowed: true },
    'order:*': { allowed: true },
    'payment:*': { allowed: true },
    'user:*': { allowed: true },
    'audit:*': { allowed: true },
  },
  manager: {
    'customer:query': { allowed: true },
    'customer:create': { allowed: true },
    'customer:update': { allowed: true },
    'order:query': { allowed: true },
    'order:create': { allowed: true },
    'order:update': { allowed: true },
    'payment:query': { allowed: true },
    'payment:create': { allowed: true },
  },
  user: {
    'customer:query': { allowed: true },
    'order:query': { allowed: true },
    'payment:query': { allowed: true },
  },
  viewer: {
    'customer:query': { allowed: true },
    'order:query': { allowed: true },
  },
};

// Amount limits by role
const AMOUNT_LIMITS: Record<UserRole, number> = {
  super_admin: Infinity,
  admin: Infinity,
  manager: 10000000,
  user: 1000000,
  viewer: 0,
};

export class PermissionController {
  async check(userId: string, operation: Operation): Promise<boolean> {
    try {
      // For MVP, check hardcoded demo users first (matching permissionCheckHook logic)
      const demoUserPermissions = this.getDemoUserPermissions(userId);
      if (demoUserPermissions) {
        return this.checkDemoUserPermission(demoUserPermissions, operation);
      }

      // Get user role from database
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!user) {
        logger.warn(`User ${userId} not found, denying permission`);
        return false;
      }

      // For MVP, assign default role based on userId pattern
      // In production, this would come from a UserRole field in the database
      const role = this.determineUserRole(userId);

      // Check basic permission
      const permKey = `${operation.entity}:${operation.type}`;
      const permConfig = PERMISSION_MATRIX[role]?.[permKey];

      if (!permConfig?.allowed && !PERMISSION_MATRIX[role]?.['*']?.allowed) {
        logger.info(`Permission denied for ${role} on ${permKey}`);
        return false;
      }

      // Check amount limit
      if (operation.amount !== undefined) {
        const amountLimit = AMOUNT_LIMITS[role];
        if (operation.amount > amountLimit) {
          logger.info(`Amount ${operation.amount} exceeds limit ${amountLimit} for role ${role}`);
          return false;
        }
      }

      // Check delete operations require manager+
      if (operation.type === 'delete' && role !== 'super_admin' && role !== 'admin') {
        if (operation.entity === 'customer' || operation.entity === 'order') {
          logger.info(`Delete on ${operation.entity} requires admin role`);
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Permission check error', error as Error);
      // Fail safe - deny on error
      return false;
    }
  }

  async checkDataAccess(userId: string, entity: string, recordId: string): Promise<boolean> {
    try {
      const role = this.determineUserRole(userId);

      // Super admin and admin can access all data
      if (role === 'super_admin' || role === 'admin') {
        return true;
      }

      // Check tenant isolation (if multi-tenant)
      // For MVP, all users can access their own data
      return true;
    } catch (error) {
      logger.error('Data access check error', error as Error);
      return false;
    }
  }

  // Demo user hardcoded permissions (matching permissionCheckHook)
  private getDemoUserPermissions(userId: string): string[] | null {
    if (userId === 'admin' || userId === 'demo-user') {
      return ['*', 'admin'];
    }
    return null;
  }

  private checkDemoUserPermission(permissions: string[], operation: Operation): boolean {
    // Admin/* permissions allow everything
    if (permissions.includes('*') || permissions.includes('admin')) {
      return true;
    }

    // Check specific permission: entity:type (e.g., "customer:read")
    const requiredPerm = `${operation.entity}:${operation.type}`;
    if (permissions.includes(requiredPerm)) {
      return true;
    }

    // Check wildcard entity permission (e.g., "customer:*")
    const wildcardPerm = `${operation.entity}:*`;
    if (permissions.includes(wildcardPerm)) {
      return true;
    }

    logger.info(`Permission denied for demo user: requires ${requiredPerm}`);
    return false;
  }

  private determineUserRole(userId: string): UserRole {
    // MVP heuristic: userId starting with 'admin_' or 'manager_' gets elevated role
    if (userId.startsWith('admin_')) return 'admin';
    if (userId.startsWith('manager_')) return 'manager';
    if (userId.startsWith('viewer_')) return 'viewer';
    return 'user';
  }

  getPermissionMatrix(): typeof PERMISSION_MATRIX {
    return PERMISSION_MATRIX;
  }
}

export const permissionController = new PermissionController();

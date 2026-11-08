// =============================================================================
// Audit Log Hook - Records audit trail at post_execution phase
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';
import { auditLogger } from '@/audit/AuditLogger';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.AUDIT, 'AuditLogHook');

export class AuditLogHook implements Hook {
  name = 'audit_log';
  type: HookType = 'post_execution';
  priority = 10;
  enabledByDefault = true;

  async execute(context: HookContext): Promise<HookResult> {
    const operation = context.operation;
    const executionResult = context.metadata.executionResult as {
      success: boolean;
      error?: string;
      data?: unknown;
      affectedId?: string;
    } | undefined;

    if (!operation) {
      return { status: 'allow', allowRetry: false };
    }

    try {
      await auditLogger.log({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        userId: context.session.userId,
        operation: operation.type,
        entity: operation.entity,
        entityId: operation.id,
        before: (context.metadata.beforeState as Record<string, unknown>) || null,
        after: executionResult?.success ? (operation.data as Record<string, unknown> || null) : null,
        ip: this.getClientIp(context),
        userAgent: this.getUserAgent(context),
        result: executionResult?.success ? 'success' : 'failure',
        errorMessage: executionResult?.error,
      });

      return { status: 'allow', allowRetry: false };
    } catch (error) {
      logger.error('Failed to write audit log', error as Error);
      return {
        status: 'warn',
        message: 'Failed to write audit log',
        allowRetry: false,
      };
    }
  }

  private getClientIp(context: HookContext): string {
    // Try to get from session metadata or return empty
    return (context.session.metadata?.clientIp as string) || '';
  }

  private getUserAgent(context: HookContext): string {
    return (context.session.metadata?.userAgent as string) || '';
  }
}

export const auditLogHook = new AuditLogHook();

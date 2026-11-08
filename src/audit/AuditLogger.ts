// =============================================================================
// Audit Logger - Full-chain operation recording to database
// =============================================================================

import { prisma } from '@/lib/prisma';
import type { AuditLog } from '@/types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.AUDIT, 'AuditLogger');

export class AuditLogger {
  async log(entry: AuditLog): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          id: entry.id || crypto.randomUUID(),
          timestamp: entry.timestamp || new Date(),
          userId: entry.userId,
          operation: entry.operation,
          entity: entry.entity,
          entityId: entry.entityId,
          before: entry.before as object | undefined,
          after: entry.after as object | undefined,
          ip: entry.ip || '',
          userAgent: entry.userAgent || '',
          result: entry.result,
          errorMessage: entry.errorMessage,
        },
      });
    } catch (error) {
      // Fallback to console if database write fails
      logger.error('Audit DB write failed', error as Error, { entry });
      logger.info('AUDIT FALLBACK', { entry });
    }
  }

  async query(filters: {
    userId?: string;
    entity?: string;
    operation?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<AuditLog[]> {
    const where: Record<string, unknown> = {};

    if (filters.userId) where.userId = filters.userId;
    if (filters.entity) where.entity = filters.entity;
    if (filters.operation) where.operation = filters.operation;
    if (filters.startDate || filters.endDate) {
      where.timestamp = {};
      if (filters.startDate) (where.timestamp as Record<string, Date>).gte = filters.startDate;
      if (filters.endDate) (where.timestamp as Record<string, Date>).lte = filters.endDate;
    }

    const results = await prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 1000,
    });

    return results.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      userId: r.userId,
      operation: r.operation,
      entity: r.entity,
      entityId: r.entityId,
      before: r.before as Record<string, unknown> | null,
      after: r.after as Record<string, unknown> | null,
      ip: r.ip || '',
      userAgent: r.userAgent || '',
      result: r.result as 'success' | 'failure',
      errorMessage: r.errorMessage || undefined,
    }));
  }

  async getRecentByEntity(entity: string, entityId: string, limit = 10): Promise<AuditLog[]> {
    const results = await prisma.auditLog.findMany({
      where: { entity, entityId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return results.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      userId: r.userId,
      operation: r.operation,
      entity: r.entity,
      entityId: r.entityId,
      before: r.before as Record<string, unknown> | null,
      after: r.after as Record<string, unknown> | null,
      ip: r.ip || '',
      userAgent: r.userAgent || '',
      result: r.result as 'success' | 'failure',
      errorMessage: r.errorMessage || undefined,
    }));
  }
}

export const auditLogger = new AuditLogger();

import { prisma } from '@/lib/prisma';
import { LogLevel } from '../LogLevel';
import { LogCategory } from '../LogCategory';
import type { LogEntry } from '../LogEntry';
import type { LogOutput } from '../Logger';

const PERSISTENT_CATEGORIES = [LogCategory.AUDIT, LogCategory.SECURITY, LogCategory.BUSINESS];

export class DatabaseOutput implements LogOutput {
  async write(entry: LogEntry): Promise<void> {
    // Only persist certain categories to database
    if (!PERSISTENT_CATEGORIES.includes(entry.category)) {
      return;
    }

    try {
      await prisma.auditLog.create({
        data: {
          id: entry.id,
          timestamp: entry.timestamp,
          userId: entry.userId || 'system',
          operation: `${entry.category}:${entry.message}`,
          entity: entry.component || 'SYSTEM',
          entityId: entry.requestId || entry.id,
          before: undefined,
          after: entry.metadata as object || null,
          result: entry.level >= LogLevel.ERROR ? 'failure' : 'success',
          errorMessage: entry.error?.message,
        },
      });
    } catch (error) {
      // Fallback to console if database write fails
      console.error('[DatabaseOutput] Failed to write audit log:', error);
    }
  }
}
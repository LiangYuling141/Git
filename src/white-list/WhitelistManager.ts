// =============================================================================
// Whitelist Manager - Fast track and whitelist management
// =============================================================================

import { prisma } from '@/lib/prisma';

export type WhitelistLevel = 'none' | 'WL1' | 'WL2' | 'WL3';

export interface WhitelistEntry {
  userId: string;
  level: WhitelistLevel;
  enteredAt: Date;
  lastEvaluatedAt: Date;
  passedRate: number;
  monthlyTransaction: number;
}

export class WhitelistManager {
  async isInWhitelist(userId: string): Promise<boolean> {
    const entry = await prisma.whitelistEntry.findUnique({
      where: { userId },
    });
    return entry !== null && entry.level !== 'none';
  }

  async getWhitelistLevel(userId: string): Promise<WhitelistLevel> {
    const entry = await prisma.whitelistEntry.findUnique({
      where: { userId },
    });
    return (entry?.level as WhitelistLevel) || 'none';
  }

  async addToWhitelist(
    entry: Omit<WhitelistEntry, 'enteredAt' | 'lastEvaluatedAt'>
  ): Promise<void> {
    await prisma.whitelistEntry.upsert({
      where: { userId: entry.userId },
      create: {
        userId: entry.userId,
        level: entry.level,
        passedRate: entry.passedRate,
        monthlyTransaction: entry.monthlyTransaction,
      },
      update: {
        level: entry.level,
        passedRate: entry.passedRate,
        monthlyTransaction: entry.monthlyTransaction,
        lastEvaluatedAt: new Date(),
      },
    });
  }

  async removeFromWhitelist(userId: string): Promise<void> {
    await prisma.whitelistEntry
      .delete({
        where: { userId },
      })
      .catch(() => {
        // Ignore if not found
      });
  }

  async evaluateAndUpdateWhitelist(userId: string): Promise<WhitelistLevel> {
    const entry = await prisma.whitelistEntry.findUnique({
      where: { userId },
    });
    if (!entry) return 'none';

    // Simple evaluation: high pass rate + high transaction = higher level
    let newLevel: WhitelistLevel = 'none';

    if (entry.passedRate > 95 && entry.monthlyTransaction > 100000) {
      newLevel = 'WL1';
    }
    if (entry.passedRate > 98 && entry.monthlyTransaction > 500000) {
      newLevel = 'WL2';
    }
    if (entry.passedRate > 99 && entry.monthlyTransaction > 1000000) {
      newLevel = 'WL3';
    }

    await prisma.whitelistEntry.update({
      where: { userId },
      data: {
        level: newLevel,
        lastEvaluatedAt: new Date(),
      },
    });

    return newLevel;
  }

  async getFastTrackSkipCount(userId: string): Promise<number> {
    const level = await this.getWhitelistLevel(userId);
    switch (level) {
      case 'WL3':
        return 2; // All votes skipped for L2 operations
      case 'WL2':
        return 1; // Skip 1 vote for L2 operations
      case 'WL1':
        return 1; // Skip 1 vote for L1 operations
      default:
        return 0;
    }
  }
}

export const whitelistManager = new WhitelistManager();
import type { Prisma } from '@/generated/prisma';
import { TefError, riskFromDb, riskToDb } from './errors';
import type { Check, DiffEntry, RiskOutcome } from './types';

/**
 * 预览快照存储（§4.1）。
 *
 * 快照是执行参数的唯一来源：执行时按 previewId 取回归一化参数，
 * 模型无法在批准之后修改它（公理 I3）。
 *
 * TTL 必须长于令牌 TTL——令牌还在有效期内而快照已经消失，
 * 会让一次合法的人工确认无法执行。
 */

export const PREVIEW_TTL_MS = 30 * 60 * 1000;

type Db = Pick<Prisma.TransactionClient, 'previewSnapshot'>;

export interface NewPreview {
  tenantId: string;
  userId: string;
  sessionId: string;
  traceId: string;
  contract: string;
  contractVersion: string;
  normalizedArgs: Record<string, unknown>;
  intentHash: string;
  evidenceDigest: string;
  evidence: Record<string, unknown>;
  diff: DiffEntry[];
  risk: RiskOutcome;
  reasons: string[];
  failedChecks: Check[];
}

export interface StoredPreview extends NewPreview {
  previewId: string;
  status: 'active' | 'consumed' | 'expired' | 'revoked';
  createdAt: Date;
  expiresAt: Date;
}

function toStored(row: {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  traceId: string;
  contract: string;
  contractVersion: string;
  normalizedArgs: Prisma.JsonValue;
  intentHash: string;
  evidenceDigest: string;
  evidence: Prisma.JsonValue;
  diff: Prisma.JsonValue;
  risk: 'L0' | 'L1' | 'L2' | 'BLOCK';
  reasons: string[];
  failedChecks: Prisma.JsonValue | null;
  status: 'active' | 'consumed' | 'expired' | 'revoked';
  createdAt: Date;
  expiresAt: Date;
}): StoredPreview {
  return {
    previewId: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    sessionId: row.sessionId,
    traceId: row.traceId,
    contract: row.contract,
    contractVersion: row.contractVersion,
    normalizedArgs: row.normalizedArgs as Record<string, unknown>,
    intentHash: row.intentHash,
    evidenceDigest: row.evidenceDigest,
    evidence: row.evidence as Record<string, unknown>,
    diff: row.diff as unknown as DiffEntry[],
    risk: riskFromDb(row.risk),
    reasons: row.reasons,
    failedChecks: (row.failedChecks as unknown as Check[] | null) ?? [],
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export class PreviewStore {
  async save(input: NewPreview, db: Db, now: Date = new Date()): Promise<StoredPreview> {
    const row = await db.previewSnapshot.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        sessionId: input.sessionId,
        traceId: input.traceId,
        contract: input.contract,
        contractVersion: input.contractVersion,
        status: 'active',
        normalizedArgs: input.normalizedArgs as Prisma.InputJsonValue,
        intentHash: input.intentHash,
        evidenceDigest: input.evidenceDigest,
        evidence: input.evidence as Prisma.InputJsonValue,
        diff: input.diff as unknown as Prisma.InputJsonValue,
        risk: riskToDb(input.risk),
        reasons: input.reasons,
        failedChecks: input.failedChecks as unknown as Prisma.InputJsonValue,
        createdAt: now,
        expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
      },
    });
    return toStored(row);
  }

  async load(tenantId: string, previewId: string, db: Db): Promise<StoredPreview | null> {
    const row = await db.previewSnapshot.findFirst({ where: { id: previewId, tenantId } });
    return row ? toStored(row) : null;
  }

  /**
   * 一次性消费。用 updateMany 的条件更新做原子状态迁移：
   * 两个并发请求只有一个能拿到 count === 1，另一个得到 CONFLICT。
   */
  async consume(tenantId: string, previewId: string, db: Db, now: Date = new Date()): Promise<StoredPreview> {
    const updated = await db.previewSnapshot.updateMany({
      where: { id: previewId, tenantId, status: 'active', expiresAt: { gt: now } },
      data: { status: 'consumed', consumedAt: now },
    });

    if (updated.count === 1) {
      const row = await db.previewSnapshot.findFirst({ where: { id: previewId, tenantId } });
      if (!row) throw new TefError('INTERNAL', `preview ${previewId} vanished after being consumed`);
      return toStored(row);
    }

    const existing = await this.load(tenantId, previewId, db);
    if (!existing) {
      throw new TefError('NOT_FOUND', `preview snapshot ${previewId} does not exist in this tenant`);
    }
    if (existing.status !== 'active') {
      throw new TefError('CONFLICT', `preview snapshot ${previewId} is already ${existing.status}`);
    }
    throw new TefError('CONFLICT', `preview snapshot ${previewId} expired at ${existing.expiresAt.toISOString()}`);
  }

  /** 冲突恢复时作废旧快照，强制重新预览（§12.2）。 */
  async revoke(tenantId: string, previewId: string, db: Db): Promise<boolean> {
    const updated = await db.previewSnapshot.updateMany({
      where: { id: previewId, tenantId, status: 'active' },
      data: { status: 'revoked' },
    });
    return updated.count > 0;
  }

  /** 定时清理过期快照。返回清理条数。 */
  async expireStale(db: Db, now: Date = new Date()): Promise<number> {
    const updated = await db.previewSnapshot.updateMany({
      where: { status: 'active', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    return updated.count;
  }
}

export const previewStore = new PreviewStore();

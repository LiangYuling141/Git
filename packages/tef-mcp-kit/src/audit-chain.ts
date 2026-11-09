import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma';
import { GENESIS_HASH, computeAuditPayloadDigest, computeChainHash } from '@lymtrix/tef-core';
import { TefError, riskFromDb, riskToDb } from '@lymtrix/tef-core';
import type { ActorType, AuditDecision, AuditEventPayload, AuditResultType, RiskOutcome } from '@lymtrix/tef-core';

/**
 * 审计哈希链（§10）。
 *
 * 只追加：`hash = H(prevHash ‖ canonical(event))`。改动任何一条历史事件，
 * 或删掉中间一条，都会让后续所有哈希对不上——这就是"一切可回放"（公理 I6）
 * 在工程上的兑现方式。
 *
 * 每租户一条链，链头行是追加时的乐观锁锚点。
 *
 * 审计写入失败必须让业务事务一起回滚：一次没有审计记录的写入，
 * 对可信执行框架来说等同于事故，不能静默放过。
 */

type Db = Pick<Prisma.TransactionClient, 'auditEvent' | 'auditChainHead'>;

const APPEND_RETRIES = 3;

export interface AuditEventInput {
  /**
   * 可选确定性事件 ID（如 `${attemptId}:result`）。对账重放时用同一 ID 写入，
   * 避免重复事件把链拉长；不传则沿用随机 `aud_<uuid>`。
   */
  eventId?: string;
  traceId: string;
  tenantId: string;
  actorId: string;
  actorType: ActorType;
  tool: string;
  contract: string;
  contractVersion: string;
  intentHash: string;
  /** 必须已经过 redactArgs 处理 */
  argsRedacted: Record<string, unknown>;
  evidenceDigest: string;
  risk: RiskOutcome;
  reasons: string[];
  decision: AuditDecision;
  result: AuditResultType;
  subjectRef?: string | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
}

export interface AppendedEvent {
  eventId: string;
  seq: number;
  prevHash: string;
  hash: string;
  payloadDigest: string;
}

export type ChainVerification =
  | { ok: true; tenantId: string; length: number; headHash: string }
  | { ok: false; tenantId: string; length: number; brokenAtSeq: number | null; reason: string };

/**
 * 参与哈希的事件本体。键集合必须固定：多一个或少一个键，
 * 重算出来的哈希就对不上，链校验会误报。
 */
function buildPayload(input: AuditEventInput, seq: number, eventId: string, ts: Date): AuditEventPayload {
  return {
    eventId,
    traceId: input.traceId,
    tenantId: input.tenantId,
    seq,
    actorId: input.actorId,
    actorType: input.actorType,
    tool: input.tool,
    contract: input.contract,
    contractVersion: input.contractVersion,
    intentHash: input.intentHash,
    argsRedacted: input.argsRedacted,
    evidenceDigest: input.evidenceDigest,
    risk: input.risk,
    reasons: input.reasons,
    decision: input.decision,
    result: input.result,
    subjectRef: input.subjectRef ?? null,
    modelVersion: input.modelVersion ?? null,
    promptVersion: input.promptVersion ?? null,
    ts: ts.toISOString(),
  };
}

export class AuditChain {
  async append(input: AuditEventInput, db: Db, now: Date = new Date()): Promise<AppendedEvent> {
    let lastError: unknown;

    for (let attempt = 0; attempt < APPEND_RETRIES; attempt += 1) {
      try {
        return await this.appendOnce(input, db, now);
      } catch (error) {
        lastError = error;
        // 只有链头被并发推进时才重试；其它错误立刻抛出。
        if (!(error instanceof TefError) || error.code !== 'CONFLICT') throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new TefError('INTERNAL', 'audit append failed');
  }

  private async appendOnce(input: AuditEventInput, db: Db, now: Date): Promise<AppendedEvent> {
    // 确保链头存在。创世块的 prevHash 是 64 个 0。
    await db.auditChainHead.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, lastSeq: 0, lastHash: GENESIS_HASH },
      update: {},
    });

    const head = await db.auditChainHead.findUniqueOrThrow({ where: { tenantId: input.tenantId } });
    const seq = head.lastSeq + 1;

    // 乐观锁：并发追加时只有一个能推进 lastSeq，其余拿到 count 0 后重试。
    const claimed = await db.auditChainHead.updateMany({
      where: { tenantId: input.tenantId, lastSeq: head.lastSeq },
      data: { lastSeq: seq },
    });
    if (claimed.count !== 1) {
      throw new TefError('CONFLICT', 'audit chain head advanced concurrently');
    }

    const eventId = input.eventId ?? `aud_${randomUUID()}`;
    const payload = buildPayload(input, seq, eventId, now);
    const prevHash = head.lastHash;
    const hash = computeChainHash(prevHash, payload);
    const payloadDigest = computeAuditPayloadDigest(payload);

    await db.auditEvent.create({
      data: {
        eventId,
        traceId: input.traceId,
        tenantId: input.tenantId,
        seq,
        actorId: input.actorId,
        actorType: input.actorType,
        tool: input.tool,
        contract: input.contract,
        contractVersion: input.contractVersion,
        intentHash: input.intentHash,
        argsRedacted: input.argsRedacted as Prisma.InputJsonValue,
        evidenceDigest: input.evidenceDigest,
        risk: riskToDb(input.risk),
        reasons: input.reasons,
        decision: input.decision,
        result: input.result,
        subjectRef: input.subjectRef ?? null,
        modelVersion: input.modelVersion ?? null,
        promptVersion: input.promptVersion ?? null,
        ts: now,
        prevHash,
        hash,
        payloadDigest,
      },
    });

    await db.auditChainHead.updateMany({
      where: { tenantId: input.tenantId, lastSeq: seq },
      data: { lastHash: hash },
    });

    return { eventId, seq, prevHash, hash, payloadDigest };
  }

  /** 逐条重算，定位第一个断点。这是答辩时"审计链完整"的可验证证据。 */
  async verify(tenantId: string, db: Db): Promise<ChainVerification> {
    const rows = await db.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: 'asc' } });
    const head = await db.auditChainHead.findUnique({ where: { tenantId } });

    let expectedPrev = GENESIS_HASH;
    for (const [index, row] of rows.entries()) {
      const expectedSeq = index + 1;
      if (row.seq !== expectedSeq) {
        return {
          ok: false,
          tenantId,
          length: rows.length,
          brokenAtSeq: row.seq,
          reason: `sequence gap: expected ${expectedSeq}, found ${row.seq}`,
        };
      }
      if (row.prevHash !== expectedPrev) {
        return {
          ok: false,
          tenantId,
          length: rows.length,
          brokenAtSeq: row.seq,
          reason: 'prevHash does not match the previous event hash',
        };
      }

      const payload = rebuildPayload(row);
      const recomputedDigest = computeAuditPayloadDigest(payload);
      if (recomputedDigest !== row.payloadDigest) {
        return {
          ok: false,
          tenantId,
          length: rows.length,
          brokenAtSeq: row.seq,
          reason: 'event content no longer matches its stored payload digest (tampered)',
        };
      }

      const recomputedHash = computeChainHash(row.prevHash, payload);
      if (recomputedHash !== row.hash) {
        return {
          ok: false,
          tenantId,
          length: rows.length,
          brokenAtSeq: row.seq,
          reason: 'chain hash mismatch',
        };
      }

      expectedPrev = row.hash;
    }

    if (head && rows.length > 0 && head.lastHash !== expectedPrev) {
      return {
        ok: false,
        tenantId,
        length: rows.length,
        brokenAtSeq: null,
        reason: 'chain head does not point at the last event',
      };
    }
    if (head && head.lastSeq !== rows.length) {
      return {
        ok: false,
        tenantId,
        length: rows.length,
        brokenAtSeq: null,
        reason: `chain head seq ${head.lastSeq} does not match event count ${rows.length}`,
      };
    }

    return { ok: true, tenantId, length: rows.length, headHash: head?.lastHash ?? GENESIS_HASH };
  }

  /** audit.trace：按 traceId 还原一次任务的完整决策链。 */
  async trace(traceId: string, tenantId: string, db: Db): Promise<AuditEventPayload[]> {
    const rows = await db.auditEvent.findMany({ where: { traceId, tenantId }, orderBy: { seq: 'asc' } });
    return rows.map(rebuildPayload);
  }

  async recentForSubject(subjectRef: string, tenantId: string, db: Db, limit = 50): Promise<AuditEventPayload[]> {
    const rows = await db.auditEvent.findMany({
      where: { subjectRef, tenantId },
      orderBy: { seq: 'desc' },
      take: limit,
    });
    return rows.reverse().map(rebuildPayload);
  }
}

type AuditEventRow = {
  eventId: string;
  traceId: string;
  tenantId: string;
  seq: number;
  actorId: string;
  actorType: ActorType;
  tool: string;
  contract: string;
  contractVersion: string;
  intentHash: string;
  argsRedacted: Prisma.JsonValue;
  evidenceDigest: string;
  risk: 'L0' | 'L1' | 'L2' | 'BLOCK';
  reasons: string[];
  decision: AuditDecision;
  result: AuditResultType;
  subjectRef: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  ts: Date;
};

function rebuildPayload(row: AuditEventRow): AuditEventPayload {
  return {
    eventId: row.eventId,
    traceId: row.traceId,
    tenantId: row.tenantId,
    seq: row.seq,
    actorId: row.actorId,
    actorType: row.actorType,
    tool: row.tool,
    contract: row.contract,
    contractVersion: row.contractVersion,
    intentHash: row.intentHash,
    argsRedacted: row.argsRedacted as Record<string, unknown>,
    evidenceDigest: row.evidenceDigest,
    risk: riskFromDb(row.risk),
    reasons: row.reasons,
    decision: row.decision,
    result: row.result,
    subjectRef: row.subjectRef ?? null,
    modelVersion: row.modelVersion ?? null,
    promptVersion: row.promptVersion ?? null,
    ts: row.ts.toISOString(),
  };
}

export const auditChain = new AuditChain();

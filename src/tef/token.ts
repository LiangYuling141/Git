import type { Prisma } from '@/generated/prisma';
import { canonicalize } from './canonical';
import { TefError, riskFromDb, riskToDb } from './errors';
import { hashToken, hmacSign, hmacVerify } from './hashing';
import type { RiskOutcome } from './types';

/**
 * 一次性确认令牌（§4.3）。
 *
 * 两层保证，缺一不可：
 * - HMAC 签名（无状态）：令牌不可伪造、内容不可篡改；
 * - 数据库状态机（有状态）：一次性消费，重放返回 CONFLICT。
 *
 * 令牌绑定 tenantId / userId / sessionId / previewId / intentHash。
 * intentHash 是人批准的那份参数；执行工具只接受令牌，不接受模型重新生成的
 * 业务参数（公理 I3），所以批准之后改金额必然失败。
 *
 * L1 与 L2 共用这一套协议，唯一区别是 L2 需要先 approve（公理 I4）。
 */

export const TOKEN_TTL_MS = 15 * 60 * 1000;

const TOKEN_PREFIX = 'ct_';
const MIN_SECRET_LENGTH = 32;
export const TOKEN_SECRET_ENV = 'TEF_TOKEN_SECRET';

export interface TokenClaims {
  tenantId: string;
  userId: string;
  sessionId: string;
  previewId: string;
  intentHash: string;
  contract: string;
  contractVersion: string;
  risk: RiskOutcome;
  requiresApproval: boolean;
  issuedAt: string;
  expiresAt: string;
}

export interface TokenRequestContext {
  tenantId: string;
  userId: string;
  sessionId: string;
}

type Db = Pick<Prisma.TransactionClient, 'confirmationToken'>;

/**
 * 读取签名密钥。缺失或过短直接抛错——
 * 一个会静默降级成弱密钥的令牌系统比没有令牌更危险。
 */
export function loadTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env[TOKEN_SECRET_ENV];
  if (!secret) {
    throw new TefError('INTERNAL', `${TOKEN_SECRET_ENV} is not set; refusing to issue confirmation tokens`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new TefError(
      'INTERNAL',
      `${TOKEN_SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters, got ${secret.length}`,
    );
  }
  return secret;
}

export function issueTokenString(claims: TokenClaims, secret: string): string {
  const body = Buffer.from(canonicalize(claims), 'utf8').toString('base64url');
  return `${TOKEN_PREFIX}${body}.${hmacSign(secret, body)}`;
}

/** 只验签名与自身过期时间；生命周期状态由 TokenStore 查库判定。 */
export function verifyTokenString(token: string, secret: string, now: Date = new Date()): TokenClaims {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    throw new TefError('VALIDATION_ERROR', 'malformed confirmation token');
  }
  const withoutPrefix = token.slice(TOKEN_PREFIX.length);
  const separator = withoutPrefix.lastIndexOf('.');
  if (separator <= 0) {
    throw new TefError('VALIDATION_ERROR', 'malformed confirmation token');
  }
  const body = withoutPrefix.slice(0, separator);
  const signature = withoutPrefix.slice(separator + 1);

  if (!hmacVerify(secret, body, signature)) {
    throw new TefError('PERMISSION_DENIED', 'confirmation token signature is invalid');
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw new TefError('VALIDATION_ERROR', 'confirmation token payload is not valid JSON');
  }

  if (new Date(claims.expiresAt).getTime() <= now.getTime()) {
    throw new TefError('CONFLICT', `confirmation token expired at ${claims.expiresAt}`);
  }
  return claims;
}

export interface IssueTokenInput extends TokenRequestContext {
  previewId: string;
  intentHash: string;
  contract: string;
  contractVersion: string;
  risk: RiskOutcome;
  traceId: string;
}

export interface StoredToken {
  tokenId: string;
  tokenHash: string;
  claims: TokenClaims;
  status: 'issued' | 'approved' | 'used' | 'rejected' | 'expired' | 'revoked';
  approvedBy: string | null;
  traceId: string;
  expiresAt: Date;
}

function toStored(row: {
  id: string;
  tokenHash: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  previewId: string;
  intentHash: string;
  contract: string;
  contractVersion: string;
  risk: 'L0' | 'L1' | 'L2' | 'BLOCK';
  status: 'issued' | 'approved' | 'used' | 'rejected' | 'expired' | 'revoked';
  requiresApproval: boolean;
  approvedBy: string | null;
  issuedAt: Date;
  expiresAt: Date;
  traceId: string;
}): StoredToken {
  return {
    tokenId: row.id,
    tokenHash: row.tokenHash,
    status: row.status,
    approvedBy: row.approvedBy,
    traceId: row.traceId,
    expiresAt: row.expiresAt,
    claims: {
      tenantId: row.tenantId,
      userId: row.userId,
      sessionId: row.sessionId,
      previewId: row.previewId,
      intentHash: row.intentHash,
      contract: row.contract,
      contractVersion: row.contractVersion,
      risk: riskFromDb(row.risk),
      requiresApproval: row.requiresApproval,
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    },
  };
}

export class TokenStore {
  /** 签发令牌并落库。返回的 token 字符串只此一次可见，库里只存摘要。 */
  async issue(
    input: IssueTokenInput,
    db: Db,
    secret: string,
    now: Date = new Date(),
  ): Promise<{ token: string; stored: StoredToken }> {
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
    const claims: TokenClaims = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      previewId: input.previewId,
      intentHash: input.intentHash,
      contract: input.contract,
      contractVersion: input.contractVersion,
      // Block 永远不会走到签发这一步；真走到了就是上游缺陷，按需要人工确认处理最安全。
      risk: input.risk,
      requiresApproval: input.risk === 'L2',
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    const token = issueTokenString(claims, secret);
    const row = await db.confirmationToken.create({
      data: {
        tokenHash: hashToken(token),
        tenantId: claims.tenantId,
        previewId: claims.previewId,
        userId: claims.userId,
        sessionId: claims.sessionId,
        intentHash: claims.intentHash,
        contract: claims.contract,
        contractVersion: claims.contractVersion,
        risk: riskToDb(claims.risk),
        status: 'issued',
        requiresApproval: claims.requiresApproval,
        issuedAt: now,
        expiresAt,
        traceId: input.traceId,
      },
    });
    return { token, stored: toStored(row) };
  }

  /** 人工批准。只对 L2 令牌有意义，且只能从 issued 迁移到 approved。 */
  async approve(token: string, approverId: string, db: Db, secret: string, now: Date = new Date()): Promise<StoredToken> {
    const claims = verifyTokenString(token, secret, now);
    if (!claims.requiresApproval) {
      throw new TefError('CONFLICT', 'this token is L1 and takes effect on issue; approval is not part of the protocol');
    }
    const transitioned = await db.confirmationToken.updateMany({
      where: { tokenHash: hashToken(token), tenantId: claims.tenantId, status: 'issued', expiresAt: { gt: now } },
      data: { status: 'approved', approvedBy: approverId, approvedAt: now },
    });
    return this.afterTransition(transitioned.count, token, claims, db, now, 'approve');
  }

  /** 人工拒绝。终态，之后任何执行都返回 CONFLICT。 */
  async reject(token: string, approverId: string, db: Db, secret: string, now: Date = new Date()): Promise<StoredToken> {
    const claims = verifyTokenString(token, secret, now);
    const transitioned = await db.confirmationToken.updateMany({
      where: {
        tokenHash: hashToken(token),
        tenantId: claims.tenantId,
        status: { in: ['issued', 'approved'] },
      },
      data: { status: 'rejected', rejectedBy: approverId, rejectedAt: now },
    });
    return this.afterTransition(transitioned.count, token, claims, db, now, 'reject');
  }

  /**
   * 消费令牌以执行写入。
   *
   * 顺序很重要：先验签名（挡伪造），再验绑定（挡跨租户/跨会话重放），
   * 最后用条件更新做原子状态迁移（挡并发重放）。
   */
  async consume(
    token: string,
    request: TokenRequestContext,
    db: Db,
    secret: string,
    now: Date = new Date(),
  ): Promise<StoredToken> {
    const claims = verifyTokenString(token, secret, now);
    this.assertBindings(claims, request);

    const expectedStatus = claims.requiresApproval ? 'approved' : 'issued';
    const transitioned = await db.confirmationToken.updateMany({
      where: { tokenHash: hashToken(token), tenantId: claims.tenantId, status: expectedStatus },
      data: { status: 'used', usedAt: now },
    });
    return this.afterTransition(transitioned.count, token, claims, db, now, 'consume');
  }

  /** 冲突恢复：作废某个预览下的全部未使用令牌（§12.2）。 */
  async revokeByPreview(tenantId: string, previewId: string, db: Db): Promise<number> {
    const updated = await db.confirmationToken.updateMany({
      where: { tenantId, previewId, status: { in: ['issued', 'approved'] } },
      data: { status: 'revoked' },
    });
    return updated.count;
  }

  async expireStale(db: Db, now: Date = new Date()): Promise<number> {
    const updated = await db.confirmationToken.updateMany({
      where: { status: { in: ['issued', 'approved'] }, expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    return updated.count;
  }

  async findByHash(token: string, db: Db): Promise<StoredToken | null> {
    const row = await db.confirmationToken.findFirst({ where: { tokenHash: hashToken(token) } });
    return row ? toStored(row) : null;
  }

  /**
   * 绑定校验。令牌是签给"这个租户里的这个用户的这个会话"的，
   * 换个上下文拿出来用就是越权，不是冲突。
   */
  private assertBindings(claims: TokenClaims, request: TokenRequestContext): void {
    if (claims.tenantId !== request.tenantId) {
      throw new TefError('PERMISSION_DENIED', 'confirmation token belongs to a different tenant');
    }
    if (claims.userId !== request.userId) {
      throw new TefError('PERMISSION_DENIED', 'confirmation token belongs to a different user');
    }
    if (claims.sessionId !== request.sessionId) {
      throw new TefError('PERMISSION_DENIED', 'confirmation token belongs to a different session');
    }
  }

  private async afterTransition(
    count: number,
    token: string,
    claims: TokenClaims,
    db: Db,
    now: Date,
    action: 'approve' | 'reject' | 'consume',
  ): Promise<StoredToken> {
    if (count === 1) {
      const stored = await this.findByHash(token, db);
      if (!stored) throw new TefError('INTERNAL', 'token vanished after a successful state transition');
      return stored;
    }

    const existing = await this.findByHash(token, db);
    if (!existing) {
      throw new TefError('CONFLICT', 'confirmation token is not recognized by this server');
    }
    if (existing.expiresAt.getTime() <= now.getTime()) {
      throw new TefError('CONFLICT', `confirmation token expired at ${existing.expiresAt.toISOString()}`);
    }
    if (existing.status === 'used') {
      // 重放。同一条写入不能被执行两次。
      throw new TefError('CONFLICT', 'confirmation token has already been used; re-preview to obtain a new one');
    }
    if (existing.status === 'revoked') {
      throw new TefError('CONFLICT', 'confirmation token was revoked; re-preview to obtain a new one');
    }
    if (existing.status === 'rejected') {
      throw new TefError('CONFLICT', 'confirmation token was rejected by a human approver');
    }
    if (action === 'consume' && claims.requiresApproval && existing.status === 'issued') {
      throw new TefError('NEEDS_CONFIRMATION', 'this L2 token has not been approved by a human yet');
    }
    throw new TefError('CONFLICT', `cannot ${action} a token in status ${existing.status}`);
  }
}

export const tokenStore = new TokenStore();

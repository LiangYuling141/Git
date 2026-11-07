import { describe, expect, it } from 'vitest';
import {
  TOKEN_SECRET_ENV,
  TOKEN_TTL_MS,
  TokenStore,
  issueTokenString,
  loadTokenSecret,
  verifyTokenString,
  type TokenClaims,
} from './token';
import { TefError } from './errors';

const SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
const T0 = new Date('2026-11-07T10:00:00.000Z');

// ---------------------------------------------------------------------------
// 内存版 confirmationToken 表：只实现 TokenStore 用到的三种操作，
// 目的是把生命周期与重放逻辑放在真实断言下，而不是靠 mock 断言调用次数。
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const spec = condition as Record<string, unknown>;
      if ('in' in spec) return (spec.in as unknown[]).includes(value);
      if ('gt' in spec) return (value as Date) > (spec.gt as Date);
      if ('lte' in spec) return (value as Date) <= (spec.lte as Date);
      return false;
    }
    return value === condition;
  });
}

function createFakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const db = {
    confirmationToken: {
      async create({ data }: { data: Row }) {
        const row: Row = { ...data, id: `tok_${(seq += 1)}`, approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, usedAt: null };
        rows.push(row);
        return row;
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        const hits = rows.filter((row) => matches(row, where));
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      },
      async findFirst({ where }: { where: Row }) {
        return rows.find((row) => matches(row, where)) ?? null;
      },
    },
  };
  return { db: db as never, rows };
}

const REQUEST = { tenantId: 't_yiwu_demo', userId: 'admin', sessionId: 's_1' };

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    ...REQUEST,
    previewId: 'pv_1',
    intentHash: 'a'.repeat(64),
    contract: 'create_order',
    contractVersion: '1.0',
    risk: 'L2' as const,
    traceId: 'tr_1',
    ...overrides,
  };
}

async function issueL2(store = new TokenStore()) {
  const { db, rows } = createFakeDb();
  const issued = await store.issue(issueInput(), db, SECRET, T0);
  return { store, db, rows, ...issued };
}

describe('loadTokenSecret', () => {
  it('缺失密钥时拒绝签发，而不是静默降级', () => {
    expect(() => loadTokenSecret({} as never)).toThrow(TefError);
    expect(() => loadTokenSecret({} as never)).toThrow(new RegExp(TOKEN_SECRET_ENV));
  });

  it('密钥过短同样拒绝', () => {
    expect(() => loadTokenSecret({ [TOKEN_SECRET_ENV]: 'too-short' } as never)).toThrow(/at least 32 characters/);
  });

  it('合规密钥通过', () => {
    expect(loadTokenSecret({ [TOKEN_SECRET_ENV]: SECRET } as never)).toBe(SECRET);
  });
});

describe('令牌签名', () => {
  const claims: TokenClaims = {
    ...REQUEST,
    previewId: 'pv_1',
    intentHash: 'a'.repeat(64),
    contract: 'create_order',
    contractVersion: '1.0',
    risk: 'L2',
    requiresApproval: true,
    issuedAt: T0.toISOString(),
    expiresAt: new Date(T0.getTime() + TOKEN_TTL_MS).toISOString(),
  };

  it('签发后可验证并还原 claims', () => {
    const token = issueTokenString(claims, SECRET);
    expect(token.startsWith('ct_')).toBe(true);
    expect(verifyTokenString(token, SECRET, T0)).toEqual(claims);
  });

  it('claims 的字段顺序不影响签名（canonical 序列化）', () => {
    const reordered = { contractVersion: '1.0', contract: 'create_order', ...claims } as TokenClaims;
    expect(issueTokenString(reordered, SECRET)).toBe(issueTokenString(claims, SECRET));
  });

  it('载荷被篡改 → PERMISSION_DENIED', () => {
    const token = issueTokenString(claims, SECRET);
    const signature = token.slice(token.lastIndexOf('.') + 1);
    const forgedBody = Buffer.from(JSON.stringify({ ...claims, userId: 'attacker' }), 'utf8').toString('base64url');
    expect(() => verifyTokenString(`ct_${forgedBody}.${signature}`, SECRET, T0)).toThrow(/signature is invalid/);
  });

  it('先验签再解析：伪造载荷即使 JSON 合法也过不了签名，非法 JSON 更是到不了解析那一步', () => {
    const garbage = Buffer.from('{oops', 'utf8').toString('base64url');
    expect(() => verifyTokenString(`ct_${garbage}.sig`, SECRET, T0)).toThrow(/signature is invalid/);
  });

  it('换成别的密钥签发 → 用正确密钥验不过', () => {
    const forged = issueTokenString(claims, 'a'.repeat(40));
    expect(() => verifyTokenString(forged, SECRET, T0)).toThrow(/signature is invalid/);
  });

  it('格式不合法 → VALIDATION_ERROR，不会走到验签', () => {
    expect(() => verifyTokenString('not-a-token', SECRET, T0)).toThrow(/malformed/);
    expect(() => verifyTokenString('ct_nodot', SECRET, T0)).toThrow(/malformed/);
    expect(() => verifyTokenString('', SECRET, T0)).toThrow(/malformed/);
  });

  it('令牌自身过期 → CONFLICT，要求重新预览', () => {
    const token = issueTokenString(claims, SECRET);
    const later = new Date(T0.getTime() + TOKEN_TTL_MS + 1000);
    expect(() => verifyTokenString(token, SECRET, later)).toThrow(/expired/);
  });

  it('令牌 TTL 短于预览快照 TTL（§4.3）', () => {
    expect(TOKEN_TTL_MS).toBeLessThan(30 * 60 * 1000);
  });
});

describe('令牌生命周期', () => {
  it('L2 令牌签发后 requiresApproval 为真，未批准不能执行', async () => {
    const { store, db, token } = await issueL2();
    await expect(store.consume(token, REQUEST, db, SECRET, T0)).rejects.toThrow(/has not been approved/);
    await expect(store.consume(token, REQUEST, db, SECRET, T0)).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
  });

  it('L2 走 approve → consume 才能执行', async () => {
    const { store, db, token } = await issueL2();
    const approved = await store.approve(token, 'boss', db, SECRET, T0);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('boss');

    const used = await store.consume(token, REQUEST, db, SECRET, new Date(T0.getTime() + 1000));
    expect(used.status).toBe('used');
  });

  it('L1 令牌签发即生效，approve 不属于协议', async () => {
    const store = new TokenStore();
    const { db } = createFakeDb();
    const { token } = await store.issue(issueInput({ risk: 'L1' }), db, SECRET, T0);

    await expect(store.approve(token, 'boss', db, SECRET, T0)).rejects.toThrow(/L1/);
    const used = await store.consume(token, REQUEST, db, SECRET, T0);
    expect(used.status).toBe('used');
  });

  it('重放：第二次 consume 返回 CONFLICT', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    await store.consume(token, REQUEST, db, SECRET, T0);

    await expect(store.consume(token, REQUEST, db, SECRET, new Date(T0.getTime() + 1000))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(store.consume(token, REQUEST, db, SECRET, new Date(T0.getTime() + 1000))).rejects.toThrow(
      /already been used/,
    );
  });

  it('重复 approve 也只有一个能成功迁移', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    await expect(store.approve(token, 'boss2', db, SECRET, T0)).rejects.toThrow(TefError);
  });

  it('被拒绝后不可执行', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    await store.reject(token, 'boss', db, SECRET, T0);
    await expect(store.consume(token, REQUEST, db, SECRET, T0)).rejects.toThrow(/rejected by a human/);
  });

  it('未批准就拒绝也可以', async () => {
    const { store, db, token } = await issueL2();
    const rejected = await store.reject(token, 'boss', db, SECRET, T0);
    expect(rejected.status).toBe('rejected');
    await expect(store.consume(token, REQUEST, db, SECRET, T0)).rejects.toThrow(/rejected/);
  });

  it('冲突恢复作废令牌后不可执行', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    expect(await store.revokeByPreview(REQUEST.tenantId, 'pv_1', db)).toBe(1);
    await expect(store.consume(token, REQUEST, db, SECRET, T0)).rejects.toThrow(/revoked/);
  });

  it('过期令牌由 expireStale 标记，且不能再 approve', async () => {
    const { store, db, token, rows } = await issueL2();
    const later = new Date(T0.getTime() + TOKEN_TTL_MS + 1000);
    expect(await store.expireStale(db, later)).toBe(1);
    expect(rows[0]?.status).toBe('expired');
    await expect(store.approve(token, 'boss', db, SECRET, later)).rejects.toThrow(/expired/);
  });

  it('库里只存令牌摘要，不存令牌原文', async () => {
    const { rows, token } = await issueL2();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('令牌绑定（跨上下文重放）', () => {
  it('跨租户使用 → PERMISSION_DENIED', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    await expect(
      store.consume(token, { ...REQUEST, tenantId: 't_other' }, db, SECRET, T0),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(store.consume(token, { ...REQUEST, tenantId: 't_other' }, db, SECRET, T0)).rejects.toThrow(
      /different tenant/,
    );
  });

  it('跨用户使用 → PERMISSION_DENIED', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    await expect(store.consume(token, { ...REQUEST, userId: 'mallory' }, db, SECRET, T0)).rejects.toThrow(
      /different user/,
    );
  });

  it('跨会话使用 → PERMISSION_DENIED', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    await expect(store.consume(token, { ...REQUEST, sessionId: 's_other' }, db, SECRET, T0)).rejects.toThrow(
      /different session/,
    );
  });

  it('越权尝试不会消耗令牌：随后合法调用仍然成功', async () => {
    const { store, db, token } = await issueL2();
    await store.approve(token, 'boss', db, SECRET, T0);
    await expect(store.consume(token, { ...REQUEST, tenantId: 't_other' }, db, SECRET, T0)).rejects.toThrow(TefError);
    const used = await store.consume(token, REQUEST, db, SECRET, T0);
    expect(used.status).toBe('used');
  });

  it('不认识的令牌 → CONFLICT，不会误报成越权', async () => {
    const store = new TokenStore();
    const { db } = createFakeDb();
    const unknown = issueTokenString(
      {
        ...REQUEST,
        previewId: 'pv_x',
        intentHash: 'b'.repeat(64),
        contract: 'create_order',
        contractVersion: '1.0',
        risk: 'L1',
        requiresApproval: false,
        issuedAt: T0.toISOString(),
        expiresAt: new Date(T0.getTime() + TOKEN_TTL_MS).toISOString(),
      },
      SECRET,
    );
    await expect(store.consume(unknown, REQUEST, db, SECRET, T0)).rejects.toThrow(/not recognized/);
  });
});

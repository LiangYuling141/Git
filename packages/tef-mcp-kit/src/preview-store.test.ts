import { describe, expect, it } from 'vitest';
import { PREVIEW_TTL_MS, PreviewStore, type NewPreview } from './preview-store';
import { TefError } from '@lymatrix/tef-core';

const T0 = new Date('2026-11-07T10:00:00.000Z');

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
  return {
    rows,
    db: {
      previewSnapshot: {
        async create({ data }: { data: Row }) {
          const row: Row = { ...data, id: `pv_${(seq += 1)}`, consumedAt: null };
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
    } as never,
  };
}

const PREVIEW: NewPreview = {
  tenantId: 't_yiwu_demo',
  userId: 'admin',
  sessionId: 's_1',
  traceId: 'tr_1',
  contract: 'create_order',
  contractVersion: '1.0',
  normalizedArgs: { customerId: 'c_weiye_import', totalAmount: 10000 },
  intentHash: 'a'.repeat(64),
  evidenceDigest: 'b'.repeat(64),
  evidence: { creditAvailable: 10000 },
  diff: [{ entity: 'order', action: 'create', changes: [] }],
  risk: 'L2',
  reasons: ['amount 10000 > threshold 5000'],
  failedChecks: [],
};

describe('PreviewStore', () => {
  it('保存时按 TTL 计算过期时间', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    const saved = await store.save(PREVIEW, db, T0);

    expect(saved.status).toBe('active');
    expect(saved.expiresAt.getTime() - T0.getTime()).toBe(PREVIEW_TTL_MS);
    expect(saved.normalizedArgs).toEqual(PREVIEW.normalizedArgs);
  });

  it('取回时保留 intentHash 与 risk，Block 从库里的枚举还原', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    await store.save({ ...PREVIEW, risk: 'Block' }, db, T0);
    const loaded = await store.load(PREVIEW.tenantId, 'pv_1', db);

    expect(loaded?.risk).toBe('Block');
    expect(loaded?.reasons).toEqual(PREVIEW.reasons);
  });

  it('跨租户读不到别人的快照', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    await store.save(PREVIEW, db, T0);
    expect(await store.load('t_other', 'pv_1', db)).toBeNull();
  });

  it('一次性消费：第二次返回 CONFLICT', async () => {
    const store = new PreviewStore();
    const { db, rows } = createFakeDb();
    await store.save(PREVIEW, db, T0);

    const consumed = await store.consume(PREVIEW.tenantId, 'pv_1', db, T0);
    expect(consumed.status).toBe('consumed');
    expect(rows[0]?.consumedAt).toEqual(T0);

    await expect(store.consume(PREVIEW.tenantId, 'pv_1', db, T0)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.consume(PREVIEW.tenantId, 'pv_1', db, T0)).rejects.toThrow(/already consumed/);
  });

  it('并发消费只有一个成功：条件更新把另一个挤掉', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    await store.save(PREVIEW, db, T0);

    const results = await Promise.allSettled([
      store.consume(PREVIEW.tenantId, 'pv_1', db, T0),
      store.consume(PREVIEW.tenantId, 'pv_1', db, T0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('过期快照不能消费', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    await store.save(PREVIEW, db, T0);
    const later = new Date(T0.getTime() + PREVIEW_TTL_MS + 1000);

    await expect(store.consume(PREVIEW.tenantId, 'pv_1', db, later)).rejects.toThrow(/expired/);
  });

  it('不存在的快照 → NOT_FOUND，不是 CONFLICT', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    await expect(store.consume(PREVIEW.tenantId, 'pv_missing', db, T0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('revoke 之后不能消费（冲突恢复要强制重新预览）', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    await store.save(PREVIEW, db, T0);

    expect(await store.revoke(PREVIEW.tenantId, 'pv_1', db)).toBe(true);
    await expect(store.consume(PREVIEW.tenantId, 'pv_1', db, T0)).rejects.toThrow(/already revoked/);
    expect(await store.revoke(PREVIEW.tenantId, 'pv_1', db)).toBe(false);
  });

  it('expireStale 只清理已过期的活动快照', async () => {
    const store = new PreviewStore();
    const { db, rows } = createFakeDb();
    await store.save(PREVIEW, db, T0);
    await store.save({ ...PREVIEW, traceId: 'tr_2' }, db, new Date(T0.getTime() + PREVIEW_TTL_MS + 5000));

    const stale = new Date(T0.getTime() + PREVIEW_TTL_MS + 1000);
    expect(await store.expireStale(db, stale)).toBe(1);
    expect(rows[0]?.status).toBe('expired');
    expect(rows[1]?.status).toBe('active');
  });

  it('TefError 带稳定错误码，供工具层映射信封', async () => {
    const store = new PreviewStore();
    const { db } = createFakeDb();
    await store.save(PREVIEW, db, T0);
    await store.consume(PREVIEW.tenantId, 'pv_1', db, T0);
    const error = await store.consume(PREVIEW.tenantId, 'pv_1', db, T0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TefError);
  });
});

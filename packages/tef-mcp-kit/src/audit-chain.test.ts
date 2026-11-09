import { describe, expect, it } from 'vitest';
import { AuditChain, type AuditEventInput } from './audit-chain';
import { GENESIS_HASH, computeChainHash } from '@lymtrix/tef-core';
import { REDACTED_PLACEHOLDER, isPseudonym, pseudonymize, redactArgs } from '@lymtrix/tef-core';

const T0 = new Date('2026-11-07T10:00:00.000Z');
const TENANT = 't_yiwu_demo';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const spec = condition as Record<string, unknown>;
      if ('in' in spec) return (spec.in as unknown[]).includes(value);
      return false;
    }
    return value === condition;
  });
}

function createFakeDb() {
  const events: Row[] = [];
  const heads: Row[] = [];
  const db = {
    auditChainHead: {
      async upsert({ where, create }: { where: Row; create: Row }) {
        const existing = heads.find((row) => matches(row, where));
        if (existing) return existing;
        heads.push({ ...create });
        return heads[heads.length - 1];
      },
      async findUnique({ where }: { where: Row }) {
        return heads.find((row) => matches(row, where)) ?? null;
      },
      async findUniqueOrThrow({ where }: { where: Row }) {
        const row = heads.find((r) => matches(r, where));
        if (!row) throw new Error('chain head not found');
        return row;
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        const hits = heads.filter((row) => matches(row, where));
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        events.push({ ...data });
        return events[events.length - 1];
      },
      async findMany({ where, orderBy, take }: { where: Row; orderBy?: { seq: 'asc' | 'desc' }; take?: number }) {
        let rows = events.filter((row) => matches(row, where));
        if (orderBy?.seq === 'asc') rows = [...rows].sort((a, b) => (a.seq as number) - (b.seq as number));
        if (orderBy?.seq === 'desc') rows = [...rows].sort((a, b) => (b.seq as number) - (a.seq as number));
        if (take !== undefined) rows = rows.slice(0, take);
        return rows;
      },
    },
  };
  return { db: db as never, events, heads };
}

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    traceId: 'tr_1',
    tenantId: TENANT,
    actorId: 'admin',
    actorType: 'agent',
    tool: 'order.preview_create',
    contract: 'create_order',
    contractVersion: '1.0',
    intentHash: 'a'.repeat(64),
    argsRedacted: { customerId: 'c_weiye_import', totalAmount: 10000 },
    evidenceDigest: 'b'.repeat(64),
    risk: 'L2',
    reasons: ['amount 10000 > threshold 5000'],
    decision: 'confirm',
    result: 'success',
    subjectRef: 'cust:c_weiye_import',
    ...overrides,
  };
}

describe('AuditChain.append', () => {
  it('创世块的 prevHash 是 64 个 0，seq 从 1 开始', async () => {
    const chain = new AuditChain();
    const { db, heads } = createFakeDb();
    const appended = await chain.append(event(), db, T0);

    expect(appended.seq).toBe(1);
    expect(appended.prevHash).toBe(GENESIS_HASH);
    expect(appended.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(heads[0]).toMatchObject({ tenantId: TENANT, lastSeq: 1, lastHash: appended.hash });
  });

  it('后续事件链接前一条的哈希', async () => {
    const chain = new AuditChain();
    const { db } = createFakeDb();
    const first = await chain.append(event({ tool: 'order.preview_create' }), db, T0);
    const second = await chain.append(event({ tool: 'confirmation.approve' }), db, new Date(T0.getTime() + 1000));
    const third = await chain.append(event({ tool: 'order.execute_create' }), db, new Date(T0.getTime() + 2000));

    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
  });

  it('不同租户各自成链，互不干扰', async () => {
    const chain = new AuditChain();
    const { db } = createFakeDb();
    const a = await chain.append(event({ tenantId: 't_a' }), db, T0);
    const b = await chain.append(event({ tenantId: 't_b' }), db, T0);

    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(GENESIS_HASH);
    expect(a.hash).not.toBe(b.hash);
  });

  it('事件内容不同则哈希不同', async () => {
    const chain = new AuditChain();
    const { db } = createFakeDb();
    const a = await chain.append(event({ decision: 'allow' }), db, T0);
    const b = await chain.append(event({ decision: 'block', traceId: 'tr_2' }), db, T0);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('AuditChain.verify —— 篡改检测', () => {
  async function buildChain(n = 3) {
    const chain = new AuditChain();
    const fake = createFakeDb();
    const tools = ['order.preview_create', 'confirmation.approve', 'order.execute_create', 'audit.trace'];
    for (let i = 0; i < n; i += 1) {
      await chain.append(event({ tool: tools[i % tools.length], traceId: i === 3 ? 'tr_2' : 'tr_1' }), fake.db, new Date(T0.getTime() + i * 1000));
    }
    return { chain, ...fake };
  }

  it('完整链校验通过', async () => {
    const { chain, db } = await buildChain(3);
    const result = await chain.verify(TENANT, db);
    expect(result).toMatchObject({ ok: true, length: 3, tenantId: TENANT });
  });

  it('空链也算完整', async () => {
    const chain = new AuditChain();
    const { db } = createFakeDb();
    expect(await chain.verify(TENANT, db)).toMatchObject({ ok: true, length: 0, headHash: GENESIS_HASH });
  });

  it('改动历史事件的判定结果 → 在断点处报篡改', async () => {
    const { chain, db, events } = await buildChain(3);
    // 攻击者想把一次 block 改成 allow
    events[1].decision = 'allow';
    events[1].result = 'success';

    const result = await chain.verify(TENANT, db);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.brokenAtSeq).toBe(2);
      expect(result.reason).toContain('tampered');
    }
  });

  it('改动金额参数 → 报篡改', async () => {
    const { chain, db, events } = await buildChain(2);
    events[0].argsRedacted = { customerId: 'c_weiye_import', totalAmount: 1 };

    const result = await chain.verify(TENANT, db);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toContain('tampered');
  });

  it('删掉中间一条 → 报序号断裂', async () => {
    const { chain, db, events } = await buildChain(4);
    events.splice(1, 1);

    const result = await chain.verify(TENANT, db);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.brokenAtSeq).toBe(3);
      expect(result.reason).toContain('sequence gap');
    }
  });

  it('重算并替换某条的 hash 而不改 prevHash → 后继事件的 prevHash 对不上', async () => {
    const { chain, db, events } = await buildChain(3);
    events[0].hash = computeChainHash(GENESIS_HASH, { forged: true });

    const result = await chain.verify(TENANT, db);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.brokenAtSeq).toBe(1);
      // payloadDigest 没变但 hash 变了，先撞上 hash mismatch
      expect(result.reason).toMatch(/chain hash mismatch/);
    }
  });

  it('连 hash 一起重算，也会因为后继的 prevHash 对不上而暴露', async () => {
    const { chain, db, events } = await buildChain(3);
    const forgedHash = 'f'.repeat(64);
    events[0].hash = forgedHash;
    events[0].payloadDigest = computeChainHash(forgedHash, events[0]);

    const result = await chain.verify(TENANT, db);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.brokenAtSeq).toBe(1);
  });

  it('链头指向被改 → 报链头不一致', async () => {
    const { chain, db, heads } = await buildChain(3);
    heads[0].lastHash = 'e'.repeat(64);

    const result = await chain.verify(TENANT, db);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toContain('chain head');
  });

  it('链头 seq 与事件条数不符（整段被删）→ 报不一致', async () => {
    const { chain, db, events } = await buildChain(3);
    events.splice(0, 3);

    const result = await chain.verify(TENANT, db);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toContain('does not match event count');
  });
});

describe('AuditChain.trace', () => {
  it('按 traceId 还原一次任务的完整决策链，顺序正确', async () => {
    const chain = new AuditChain();
    const { db } = createFakeDb();
    await chain.append(event({ tool: 'order.preview_create', decision: 'confirm' }), db, T0);
    await chain.append(event({ tool: 'confirmation.approve', actorType: 'human', decision: 'allow' }), db, new Date(T0.getTime() + 1000));
    await chain.append(event({ tool: 'order.execute_create', decision: 'allow' }), db, new Date(T0.getTime() + 2000));
    await chain.append(event({ tool: 'audit.trace', traceId: 'tr_other' }), db, new Date(T0.getTime() + 3000));

    const traced = await chain.trace('tr_1', TENANT, db);
    expect(traced.map((e) => e.tool)).toEqual(['order.preview_create', 'confirmation.approve', 'order.execute_create']);
    expect(traced.map((e) => e.actorType)).toEqual(['agent', 'human', 'agent']);
    expect(traced.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('跨租户 trace 拿不到别家的事件', async () => {
    const chain = new AuditChain();
    const { db } = createFakeDb();
    await chain.append(event(), db, T0);
    expect(await chain.trace('tr_1', 't_other', db)).toEqual([]);
  });
});

describe('redactArgs（§10.2 审计不得存直接个人信息）', () => {
  it('抹掉姓名、电话、邮箱、地址、税号', () => {
    const redacted = redactArgs({
      customerId: 'c_weiye_import',
      name: '义乌市伟业进出口有限公司',
      phone: '13905791001',
      email: 'boss@weiye.example',
      address: '义乌市国际商贸城 3 区',
      taxId: '91330782MA12345678',
      totalAmount: 10000,
    });

    expect(redacted).toMatchObject({
      customerId: 'c_weiye_import',
      name: REDACTED_PLACEHOLDER,
      phone: REDACTED_PLACEHOLDER,
      email: REDACTED_PLACEHOLDER,
      address: REDACTED_PLACEHOLDER,
      taxId: REDACTED_PLACEHOLDER,
      totalAmount: 10000,
    });
  });

  it('抹掉凭据类字段', () => {
    const redacted = redactArgs({ password: 'x', token: 'y', apiKey: 'z', authorization: 'Bearer a' });
    expect(Object.values(redacted).every((v) => v === REDACTED_PLACEHOLDER)).toBe(true);
  });

  it('键名的大小写与下划线变体同样命中', () => {
    const redacted = redactArgs({ user_name: 'a', 'PHONE-NUMBER': 'b', FullName: 'c' });
    expect(redacted.user_name).toBe(REDACTED_PLACEHOLDER);
    expect(redacted['PHONE-NUMBER']).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.FullName).toBe(REDACTED_PLACEHOLDER);
  });

  it('复合命名也命中：contactPhone / buyerEmail / shipAddress', () => {
    const redacted = redactArgs({
      contactPhone: '13905791001',
      buyerEmail: 'a@b.c',
      shipAddress: '义乌',
      contactPerson: '王老板',
      idCardNo: '330782...',
    });
    expect(Object.values(redacted).every((v) => v === REDACTED_PLACEHOLDER)).toBe(true);
  });

  it('商品名与技术对象名保留：它们是审计有用性的一部分，不是个人信息', () => {
    const redacted = redactArgs({
      productName: '圣诞球 直径6cm 混色',
      skuName: 'XMAS-BALL-01',
      toolName: 'order.execute_create',
      contractName: 'create_order',
      tenantName: '义乌 demo',
    });
    expect(redacted.productName).toBe('圣诞球 直径6cm 混色');
    expect(redacted.toolName).toBe('order.execute_create');
    expect(redacted.tenantName).toBe('义乌 demo');
  });

  it('代理键保留：customerId / orderId 是回放决策链的抓手', () => {
    const redacted = redactArgs({ customerId: 'c_weiye_import', orderId: 'ord_1', subjectRef: 'cust:c_1' });
    expect(redacted).toEqual({ customerId: 'c_weiye_import', orderId: 'ord_1', subjectRef: 'cust:c_1' });
  });

  it('递归处理嵌套对象与数组', () => {
    const redacted = redactArgs({
      order: { customer: { name: '伟业', id: 'c_1' }, items: [{ sku: 'A', contactPhone: '139' }] },
    });
    const order = redacted.order as Record<string, unknown>;
    const customer = order.customer as Record<string, unknown>;
    const items = order.items as Array<Record<string, unknown>>;
    expect(customer.name).toBe(REDACTED_PLACEHOLDER);
    expect(customer.id).toBe('c_1');
    expect(items[0]?.contactPhone).toBe(REDACTED_PLACEHOLDER);
    expect(items[0]?.sku).toBe('A');
  });

  it('保留假名引用，因为它是删除权的抓手', () => {
    const pseudonym = pseudonymize('cust', 'c_weiye_import');
    expect(isPseudonym(pseudonym)).toBe(true);
    expect(redactArgs({ subjectRef: pseudonym }).subjectRef).toBe(pseudonym);
  });

  it('超长字符串被截断，避免把整段对话塞进审计', () => {
    const redacted = redactArgs({ note: 'x'.repeat(5000) }) as { note: string };
    expect(redacted.note.length).toBeLessThan(250);
    expect(redacted.note).toContain('truncated');
  });

  it('赊账订单的真实参数脱敏后不含客户名称', () => {
    const redacted = redactArgs({
      customerId: 'c_weiye_import',
      items: [{ sku: 'XMAS-BALL-01', quantity: 5000, unitPrice: 2, subtotal: 10000 }],
      depositRate: 0.3,
      termsDays: 30,
      totalAmount: 10000,
      deposit: 3000,
      balance: 7000,
    });
    expect(JSON.stringify(redacted)).not.toContain('义乌市伟业进出口有限公司');
  });
});

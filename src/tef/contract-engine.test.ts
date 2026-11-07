import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContractValidationError, contractEngine } from './contract-engine';
import { EffectExecutionError, executeEffects, type EntityAdapters } from './effect-executor';
import { classifyRisk } from './risk';
import type { Check, Contract, ExecContext, Effect } from './types';

// 一个与 CRM 无关的假契约，用来验证框架核心不依赖任何垂直字段。
interface TransferParams {
  accountId: string;
  amount: number;
  note?: string;
}

interface TransferEvidence {
  account: { id: string; balance: number; status: string } | null;
}

interface StubDb {
  accounts: Record<string, { id: string; balance: number; status: string }>;
}

const schema = z.object({
  accountId: z.string().min(1),
  amount: z.number(),
  note: z.string().optional(),
});

function makeContract(overrides: Partial<Contract<TransferParams, TransferEvidence, StubDb>> = {}) {
  const contract: Contract<TransferParams, TransferEvidence, StubDb> = {
    operation: 'transfer_funds',
    version: '1.0',
    inputSchema: schema as unknown as z.ZodType<TransferParams>,
    normalize(raw) {
      const parsed = schema.parse(raw);
      return { ...parsed, amount: Math.round(parsed.amount * 100) / 100 };
    },
    async loadEvidence(p, ctx) {
      return { account: ctx.db.accounts[p.accountId] ?? null };
    },
    preconditions(p, ev) {
      const checks: Check[] = [
        {
          id: 'account.exists',
          ok: ev.account !== null,
          code: 'NOT_FOUND',
          message: `account ${p.accountId} does not exist`,
        },
      ];
      if (ev.account) {
        checks.push({
          id: 'account.balance_sufficient',
          ok: ev.account.balance >= p.amount,
          code: 'INSUFFICIENT_BALANCE',
          message: `balance ${ev.account.balance}, needs ${p.amount}`,
        });
        checks.push({
          id: 'account.status_active',
          ok: ev.account.status === 'active',
          code: 'ACCOUNT_FROZEN',
          message: `account status is ${ev.account.status}`,
        });
      }
      return checks;
    },
    invariants(p) {
      return [
        {
          id: 'amount.positive',
          ok: p.amount > 0,
          code: 'NON_POSITIVE_AMOUNT',
          message: `amount must be positive, got ${p.amount}`,
        },
      ];
    },
    permissions(_p, ctx) {
      return [
        {
          id: 'role.allowed',
          ok: ctx.role === 'owner' || ctx.role === 'finance',
          code: 'PERMISSION_DENIED',
          message: `role ${ctx.role} cannot transfer funds`,
        },
      ];
    },
    riskRules(p, ev, ctx) {
      return classifyRisk({
        opType: 'create',
        entity: 'account',
        fields: [],
        amount: p.amount,
        customer: {
          type: 'normal',
          overdueDays: 0,
          creditAvailable: ev.account?.balance ?? 0,
        },
        context: {
          timestampSnapshot: ctx.timestampSnapshot,
          recentOpCount: ctx.recentOpCount,
          whitelistLevel: ctx.whitelistLevel,
          tenantThresholds: ctx.tenantThresholds,
        },
      });
    },
    effects(p): Effect[] {
      return [
        {
          type: 'create',
          entity: 'ledger',
          as: 'entry',
          payload: { accountId: p.accountId, amount: p.amount, note: p.note ?? null },
        },
        {
          type: 'update',
          entity: 'account',
          target: p.accountId,
          payload: {},
          increment: { balance: -p.amount },
        },
      ];
    },
    compensation(p, _ev, r) {
      const entryId = r.refs.entry?.id as string | undefined;
      return [
        { type: 'update', entity: 'ledger', target: entryId ?? '', payload: { status: 'voided' } },
        { type: 'update', entity: 'account', target: p.accountId, payload: {}, increment: { balance: p.amount } },
      ];
    },
    audit(p, ev, r) {
      return {
        subjectRef: `acct:${p.accountId.slice(0, 4)}`,
        before: { balance: ev.account?.balance ?? null },
        after: { balance: r ? ((r.refs.account?.balance as number) ?? null) : null },
      };
    },
    diff(p, ev) {
      return [
        {
          entity: 'account',
          action: 'update',
          label: `从 ${p.accountId} 转出 ${p.amount}`,
          changes: [{ field: 'balance', before: ev.account?.balance, after: (ev.account?.balance ?? 0) - p.amount }],
        },
      ];
    },
    ...overrides,
  };
  return contract;
}

function makeCtx(db: StubDb, overrides: Partial<ExecContext<StubDb>> = {}): ExecContext<StubDb> {
  return {
    tenantId: 't_test',
    userId: 'u_owner',
    sessionId: 's_1',
    role: 'owner',
    traceId: 'tr_1',
    timestampSnapshot: new Date('2026-11-07T00:00:00.000Z'),
    recentOpCount: 0,
    whitelistLevel: 'none',
    tenantThresholds: { amountL2Threshold: 5000 },
    db,
    ...overrides,
  };
}

const HEALTHY_DB: StubDb = { accounts: { acc_1: { id: 'acc_1', balance: 100000, status: 'active' } } };

describe('ContractEngine.preview', () => {
  it('正常路径产出 risk / diff / effects 与两层哈希', async () => {
    const outcome = await contractEngine.preview(makeContract(), { accountId: 'acc_1', amount: 10000 }, makeCtx(HEALTHY_DB));

    expect(outcome.blocked).toBe(false);
    expect(outcome.risk).toBe('L2');
    expect(outcome.reasons.join(' ')).toContain('threshold 5000');
    expect(outcome.effects).toHaveLength(2);
    expect(outcome.diff[0]?.label).toContain('转出 10000');
    expect(outcome.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.intentHash).not.toBe(outcome.evidenceDigest);
  });

  it('归一化后的参数才进 intentHash', async () => {
    const contract = makeContract();
    const raw = { accountId: 'acc_1', amount: 100.005 };
    const outcome = await contractEngine.preview(contract, raw, makeCtx(HEALTHY_DB));
    expect(outcome.params.amount).toBe(100.01);
    expect(outcome.intentHash).toBe(
      (await contractEngine.preview(contract, { accountId: 'acc_1', amount: 100.01 }, makeCtx(HEALTHY_DB))).intentHash,
    );
  });

  it('证据变动不改变 intentHash（§4.2 的核心论点）', async () => {
    const contract = makeContract();
    const richDb: StubDb = { accounts: { acc_1: { id: 'acc_1', balance: 100000, status: 'active' } } };
    const drainedDb: StubDb = { accounts: { acc_1: { id: 'acc_1', balance: 20000, status: 'active' } } };

    const a = await contractEngine.preview(contract, { accountId: 'acc_1', amount: 10000 }, makeCtx(richDb));
    const b = await contractEngine.preview(contract, { accountId: 'acc_1', amount: 10000 }, makeCtx(drainedDb));

    expect(a.intentHash).toBe(b.intentHash);
    expect(a.evidenceDigest).not.toBe(b.evidenceDigest);
  });

  it('参数校验失败抛 ContractValidationError，不会走到证据加载', async () => {
    await expect(contractEngine.preview(makeContract(), { accountId: '', amount: 10 }, makeCtx(HEALTHY_DB))).rejects.toThrow(
      ContractValidationError,
    );
    await expect(contractEngine.preview(makeContract(), { amount: 10 }, makeCtx(HEALTHY_DB))).rejects.toThrow(
      ContractValidationError,
    );
  });

  it('前置条件失败 → Block，且不产出任何 effect', async () => {
    const outcome = await contractEngine.preview(makeContract(), { accountId: 'acc_1', amount: 999999 }, makeCtx(HEALTHY_DB));

    expect(outcome.blocked).toBe(true);
    expect(outcome.risk).toBe('Block');
    expect(outcome.effects).toEqual([]);
    expect(outcome.failedChecks.map((c) => c.code)).toContain('INSUFFICIENT_BALANCE');
  });

  it('实体不存在 → Block(NOT_FOUND)', async () => {
    const outcome = await contractEngine.preview(makeContract(), { accountId: 'nope', amount: 10 }, makeCtx(HEALTHY_DB));
    expect(outcome.blocked).toBe(true);
    expect(outcome.failedChecks.map((c) => c.code)).toContain('NOT_FOUND');
  });

  it('权限不足 → Block(PERMISSION_DENIED)，且优先于业务判定', async () => {
    const outcome = await contractEngine.preview(
      makeContract(),
      { accountId: 'acc_1', amount: 10 },
      makeCtx(HEALTHY_DB, { role: 'viewer' }),
    );
    expect(outcome.blocked).toBe(true);
    expect(outcome.failedChecks.map((c) => c.code)).toContain('PERMISSION_DENIED');
  });

  it('warn 级 Check 失败不阻断，但会出现在 reasons 里', async () => {
    const contract = makeContract({
      invariants: (p) => [
        {
          id: 'amount.round',
          ok: Number.isInteger(p.amount),
          code: 'NON_ROUND_AMOUNT',
          message: 'amount has decimals',
          severity: 'warn',
        },
      ],
    });
    const outcome = await contractEngine.preview(contract, { accountId: 'acc_1', amount: 10.5 }, makeCtx(HEALTHY_DB));

    expect(outcome.blocked).toBe(false);
    // warn 既不阻断，也不参与定级——风险等级只由 riskRules 决定
    expect(outcome.risk).toBe('L1');
    expect(outcome.reasons.join(' ')).toContain('warn NON_ROUND_AMOUNT');
  });

  it('不变量失败 → Block', async () => {
    const outcome = await contractEngine.preview(makeContract(), { accountId: 'acc_1', amount: -5 }, makeCtx(HEALTHY_DB));
    expect(outcome.blocked).toBe(true);
    expect(outcome.failedChecks.map((c) => c.code)).toContain('NON_POSITIVE_AMOUNT');
  });

  it('契约没有 diff 时从 effects 派生兜底 diff', async () => {
    const contract = makeContract({ diff: undefined });
    const outcome = await contractEngine.preview(contract, { accountId: 'acc_1', amount: 10 }, makeCtx(HEALTHY_DB));
    expect(outcome.diff).toHaveLength(2);
    expect(outcome.diff[1]?.changes).toEqual([{ field: 'balance', delta: -10 }]);
  });
});

describe('ContractEngine.revalidate', () => {
  const params: TransferParams = { accountId: 'acc_1', amount: 10000 };

  it('证据未变 → ok，并给出可执行的 effects', async () => {
    const result = await contractEngine.revalidate(makeContract(), params, makeCtx(HEALTHY_DB), 'L2');
    expect(result.ok).toBe(true);
    if (result.ok === true) expect(result.effects).toHaveLength(2);
  });

  it('并发把余额抽走 → CONFLICT(precondition)，要求重新预览', async () => {
    const drained: StubDb = { accounts: { acc_1: { id: 'acc_1', balance: 500, status: 'active' } } };
    const result = await contractEngine.revalidate(makeContract(), params, makeCtx(drained), 'L2');

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe('CONFLICT');
      expect(result.cause).toBe('precondition');
      expect(result.failedChecks.map((c) => c.code)).toContain('INSUFFICIENT_BALANCE');
    }
  });

  it('账户被冻结 → CONFLICT(precondition)', async () => {
    const frozen: StubDb = { accounts: { acc_1: { id: 'acc_1', balance: 100000, status: 'frozen' } } };
    const result = await contractEngine.revalidate(makeContract(), params, makeCtx(frozen), 'L2');
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failedChecks.map((c) => c.code)).toContain('ACCOUNT_FROZEN');
  });

  it('风险升级 → CONFLICT(risk_escalation)，人批准的是原来那个等级', async () => {
    // 模拟"预览时是 L1，执行前客户被标记为 high_risk 因而升到 L2"。
    // 金额阈值抬高到不会触发，这样升级只可能来自客户类型。
    const contract = makeContract({
      preconditions: (p, ev) => [
        { id: 'account.exists', ok: ev.account !== null, code: 'NOT_FOUND', message: `missing ${p.accountId}` },
      ],
      riskRules: (p, ev, ctx) =>
        classifyRisk({
          opType: 'create',
          entity: 'account',
          fields: [],
          amount: p.amount,
          customer: {
            type: ev.account?.status === 'flagged' ? 'high_risk' : 'normal',
            overdueDays: 0,
            creditAvailable: ev.account?.balance ?? 0,
          },
          context: {
            timestampSnapshot: ctx.timestampSnapshot,
            recentOpCount: ctx.recentOpCount,
            whitelistLevel: ctx.whitelistLevel,
            tenantThresholds: { amountL2Threshold: 999999 },
          },
        }),
    });
    const flagged: StubDb = { accounts: { acc_1: { id: 'acc_1', balance: 100000, status: 'flagged' } } };

    const result = await contractEngine.revalidate(contract, params, makeCtx(flagged), 'L1');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.cause).toBe('risk_escalation');
      expect(result.reasons.join(' ')).toContain('risk escalated from L1 to L2');
    }
  });

  it('风险不变或下降不算冲突', async () => {
    const result = await contractEngine.revalidate(makeContract(), params, makeCtx(HEALTHY_DB), 'L2');
    expect(result.ok).toBe(true);
  });
});

describe('executeEffects', () => {
  function stubAdapters(log: Array<Record<string, unknown>>): EntityAdapters {
    return {
      ledger: {
        async create(payload) {
          const row = { id: 'led_1', ...payload };
          log.push({ op: 'create', entity: 'ledger', row });
          return row;
        },
        async update(target, payload) {
          log.push({ op: 'update', entity: 'ledger', target, payload });
          return { id: target, ...payload };
        },
      },
      account: {
        async create(payload) {
          log.push({ op: 'create', entity: 'account', row: payload });
          return payload;
        },
        async update(target, payload, increment) {
          log.push({ op: 'update', entity: 'account', target, payload, increment });
          return { id: target, balance: 90000, ...payload };
        },
      },
    };
  }

  it('按顺序执行 create 与带增量的 update', async () => {
    const log: Array<Record<string, unknown>> = [];
    const effects = makeContract().effects({ accountId: 'acc_1', amount: 10000 }, { account: null });
    const result = await executeEffects(effects, stubAdapters(log));

    expect(result.ok).toBe(true);
    expect(result.refs.entry?.id).toBe('led_1');
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ op: 'update', entity: 'account', target: 'acc_1', increment: { balance: -10000 } });
  });

  it('bind 把前序产物注入后续 payload', async () => {
    const log: Array<Record<string, unknown>> = [];
    const effects: Effect[] = [
      { type: 'create', entity: 'ledger', as: 'entry', payload: { amount: 5 } },
      { type: 'update', entity: 'ledger', target: 'x', payload: {}, bind: { entryId: { fromRef: 'entry', field: 'id' } } },
    ];
    // 第二个 effect 走 account 适配器以便观察 payload
    effects[1] = { ...effects[1], entity: 'account', target: 'acc_1', bind: { entryId: { fromRef: 'entry', field: 'id' } } };

    await executeEffects(effects, stubAdapters(log));
    expect(log[1]).toMatchObject({ entity: 'account', payload: { entryId: 'led_1' } });
  });

  it('引用不存在的 ref 时报 INTERNAL，而不是静默写入 undefined', async () => {
    const effects: Effect[] = [
      { type: 'update', entity: 'account', target: 'acc_1', payload: {}, bind: { x: { fromRef: 'missing', field: 'id' } } },
    ];
    await expect(executeEffects(effects, stubAdapters([]))).rejects.toThrow(EffectExecutionError);
  });

  it('没有注册适配器的实体直接报错', async () => {
    const effects: Effect[] = [{ type: 'create', entity: 'unknown_entity', payload: {} }];
    await expect(executeEffects(effects, stubAdapters([]))).rejects.toThrow(/no adapter registered/);
  });

  it('update 缺少 target 直接报错', async () => {
    const effects: Effect[] = [{ type: 'update', entity: 'account', payload: {} }];
    await expect(executeEffects(effects, stubAdapters([]))).rejects.toThrow(/requires a target id/);
  });

  it('补偿动作可以从执行结果反推', async () => {
    const contract = makeContract();
    const log: Array<Record<string, unknown>> = [];
    const result = await executeEffects(
      contract.effects({ accountId: 'acc_1', amount: 10000 }, { account: null }),
      stubAdapters(log),
    );
    const compensation = contract.compensation({ accountId: 'acc_1', amount: 10000 }, { account: null }, result);

    expect(compensation[0]?.target).toBe('led_1');
    expect(compensation[1]?.increment).toEqual({ balance: 10000 });
  });
});

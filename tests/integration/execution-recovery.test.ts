import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EffectsExecutionUnknownError,
  type EffectsExecuteRequest,
  type EffectsExecuteResult,
  type EffectsExecutor,
  type Envelope,
} from '@lymtrix/tef-core';
import {
  auditChain,
  reconcileExecutions,
  scopedExecutorIdempotencyKey,
  type ReconciliationReport,
} from '@lymtrix/tef-mcp-kit';
import { createInProcessCrmEffectsExecutor } from '@lymtrix/vertical-crm-erp';
import { prisma } from '@/lib/prisma';
import {
  confirmationApprove,
  orderExecuteCreate,
  orderPreviewCreate,
  type Principal,
} from '@/mcp-server';
import { resolveTenantContext } from '@/tef/tenant';
import { withTenantScope } from '@/tef/tenant-scope';
import { loadTokenSecret } from '@/tef/token';

/**
 * Phase C Task 4：对账与故障注入（真实数据库）。
 *
 * 需要 PostgreSQL：`TEF_DB_TESTS=1 npx vitest run tests/integration/execution-recovery.test.ts`。
 * 默认跳过，因此没有数据库的环境不会失败。
 *
 * 覆盖：
 * 1. Phase 1 提交后崩溃（executing）→ 对账执行副作用一次并结算；
 * 2. 执行器提交后超时（unknown）→ 对账按同一幂等键重放，不重复副作用；
 * 3. 副作用成功但 Phase 3 未执行 → 对账补写结果审计，审计链校验通过；
 * 4. 预审计失败 → 不调用执行器、不创建执行尝试；
 * 5. 并发同幂等键 → 一个执行、另一个 in-progress，副作用一次；
 * 6. 令牌重放换幂等键 → CONFLICT，副作用一次；
 * 7. 库存并发预占不超卖。
 *
 * 每个用例都断言"副作用至多一次"与"结果审计至多一条"，而不仅是响应状态。
 */

const RUN_DB = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDb = RUN_DB ? describe : describe.skip;

const TENANT = 't_yiwu_demo';
const CUSTOMER = 'c_weiye_import';
const SKU = 'XMAS-BALL-01';
const CREATE_TOOL = 'order.execute_create';
const EFFECTS_TOOL = 'internal.effects.execute';
const INITIAL_AVAILABLE_QTY = 20000;

const SCENARIO = {
  customerId: CUSTOMER,
  items: [{ sku: SKU, quantity: 5000, unitPrice: 2 }],
  depositRate: 0.3,
  termsDays: 30,
};

let secret: string;
let agentPrincipal: Principal;
let humanPrincipal: Principal;
let traceSeq = 0;

function nextTrace(): string {
  traceSeq += 1;
  return `tr_recovery_${Date.now()}_${traceSeq}`;
}

/** 对账只看未结算尝试，测试间必须清理，否则 scanned 计数不可判定。 */
async function resetFixture(): Promise<void> {
  await withTenantScope(TENANT, async (tx) => {
    await tx.product.updateMany({ where: { tenantId: TENANT }, data: { reservedQty: 0 } });
    await tx.product.updateMany({ where: { tenantId: TENANT, sku: SKU }, data: { availableQty: INITIAL_AVAILABLE_QTY } });
    await tx.executionAttempt.deleteMany({
      where: { tenantId: TENANT, status: { in: ['executing', 'unknown'] } },
    });
  });
  await prisma.customer.updateMany({
    where: { tenantId: TENANT, id: CUSTOMER },
    data: {
      creditLimit: 50000,
      creditUsed: 0,
      overdueDays: 0,
      customerType: 'normal',
      isHighRisk: false,
      status: 'active',
    },
  });
}

async function previewAndApprove(
  traceId: string,
  scenario: Record<string, unknown> = SCENARIO,
): Promise<{ token: string; previewId: string }> {
  const preview = (await orderPreviewCreate(agentPrincipal, scenario, { traceId, secret })) as Envelope;
  expect(preview.status).toBe('needs_confirmation');
  expect(typeof preview.previewId).toBe('string');

  const token = preview.confirmationToken as string;
  const approved = await confirmationApprove(humanPrincipal, { confirmation_token: token }, { traceId, secret });
  expect(approved.status).toBe('ok');
  return { token, previewId: preview.previewId as string };
}

function readAttempt(attemptId: string) {
  return withTenantScope(TENANT, (tx) =>
    tx.executionAttempt.findUniqueOrThrow({ where: { attemptId } }),
  );
}

function readAttemptByKey(idempotencyKey: string) {
  return withTenantScope(TENANT, (tx) =>
    tx.executionAttempt.findFirst({ where: { tenantId: TENANT, toolName: CREATE_TOOL, idempotencyKey } }),
  );
}

function countAttemptsByKey(idempotencyKey: string): Promise<number> {
  return withTenantScope(TENANT, (tx) =>
    tx.executionAttempt.count({ where: { tenantId: TENANT, toolName: CREATE_TOOL, idempotencyKey } }),
  );
}

function countIdempotencyRecords(toolName: string, idempotencyKey: string): Promise<number> {
  return withTenantScope(TENANT, (tx) =>
    tx.idempotencyRecord.count({ where: { tenantId: TENANT, toolName, idempotencyKey } }),
  );
}

function readResultAudit(attemptId: string) {
  return withTenantScope(TENANT, (tx) =>
    tx.auditEvent.findFirst({ where: { tenantId: TENANT, eventId: `${attemptId}:result` } }),
  );
}

async function readProduct(): Promise<{ availableQty: number; reservedQty: number }> {
  const product = await withTenantScope(TENANT, (tx) =>
    tx.product.findFirst({ where: { tenantId: TENANT, sku: SKU } }),
  );
  expect(product).not.toBeNull();
  return { availableQty: product!.availableQty, reservedQty: product!.reservedQty };
}

function countOrdersByTrace(traceIds: string[]): Promise<number> {
  return prisma.order.count({ where: { tenantId: TENANT, traceId: { in: traceIds } } });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before the timeout');
}

/**
 * 用"执行器在副作用前抛未知错误"的公开执行路径制造一个真实的 attempt：
 * Phase 1 已提交（令牌/快照已消费、attempt 已创建），Phase 2 没有发生。
 */
async function captureUnknownAttempt(
  traceId: string,
  token: string,
  idempotencyKey: string,
): Promise<{ attemptId: string; input: EffectsExecuteRequest }> {
  const calls: EffectsExecuteRequest[] = [];
  const executor: EffectsExecutor = {
    async execute(input) {
      calls.push(input);
      throw new EffectsExecutionUnknownError('simulated crash before effects');
    },
  };

  const envelope = (await orderExecuteCreate(
    agentPrincipal,
    { confirmation_token: token, idempotency_key: idempotencyKey },
    { traceId, secret, effectsExecutor: executor },
  )) as Envelope;

  expect(envelope.status).toBe('error');
  expect(envelope.error?.code).toBe('INTERNAL');
  expect(calls).toHaveLength(1);

  const attempt = await readAttemptByKey(idempotencyKey);
  expect(attempt).not.toBeNull();
  expect(attempt?.status).toBe('unknown');

  return { attemptId: (attempt as { attemptId: string }).attemptId, input: calls[0] };
}

/** 模拟"Phase 1 已提交但进程在 Phase 2 之前死亡"：只回拨状态，不伪造副作用。 */
async function markExecuting(attemptId: string): Promise<void> {
  const updated = await withTenantScope(TENANT, (tx) =>
    tx.executionAttempt.updateMany({
      where: { attemptId, tenantId: TENANT, status: 'unknown' },
      data: { status: 'executing', errorCode: null, errorMessage: null },
    }),
  );
  expect(updated.count).toBe(1);
}

/** 让 executing 尝试必然落入对账扫描窗口（executing 默认有静默期）。 */
function reconciliationClock(): Date {
  return new Date(Date.now() + 1000);
}

function expectReport(report: ReconciliationReport, expected: ReconciliationReport): void {
  expect(report).toEqual(expected);
}

describeDb('对账与故障注入（真实数据库）', () => {
  beforeAll(async () => {
    secret = loadTokenSecret();
    await resetFixture();

    const resolved = await resolveTenantContext('admin', prisma, TENANT);
    agentPrincipal = { ...resolved, sessionId: 's_recovery_agent', clientKind: 'agent' };
    humanPrincipal = { ...resolved, sessionId: 's_recovery_human', clientKind: 'confirmation-ui' };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Phase 1 提交后崩溃：对账执行副作用一次并结算，结果审计存在', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const idempotencyKey = `idem_recovery_crash_${traceId}`;
    const { token } = await previewAndApprove(traceId);

    const captured = await captureUnknownAttempt(traceId, token, idempotencyKey);
    await markExecuting(captured.attemptId);
    // 对账前：没有副作用、没有结果审计。
    expect(await countOrdersByTrace([traceId])).toBe(0);
    expect(await readResultAudit(captured.attemptId)).toBeNull();

    const real = createInProcessCrmEffectsExecutor();
    const executorInputs: EffectsExecuteRequest[] = [];
    const executor: EffectsExecutor = {
      async execute(input) {
        executorInputs.push(input);
        return real.execute(input);
      },
    };

    const report = await reconcileExecutions({
      tenantId: TENANT,
      effectsExecutor: executor,
      staleAfterMs: 0,
      now: reconciliationClock(),
    });

    expectReport(report, { scanned: 1, succeeded: 1, failed: 0, unknown: 0 });

    // 对账必须沿用前台派生的执行器幂等键与证据版本。
    expect(executorInputs).toHaveLength(1);
    expect(executorInputs[0].idempotencyKey).toBe(scopedExecutorIdempotencyKey(CREATE_TOOL, idempotencyKey));
    expect(executorInputs[0].expectedEvidenceVersion).toBe(captured.input.expectedEvidenceVersion);
    expect(executorInputs[0].previewId).toBe(captured.input.previewId);

    const attempt = await readAttempt(captured.attemptId);
    expect(attempt.status).toBe('succeeded');
    expect(attempt.expectedEvidenceVersion).toBe(captured.input.expectedEvidenceVersion);
    expect(attempt.result).toMatchObject({ status: 'ok', data: { idempotencyKey } });
    expect(attempt.resultAuditEventId).toBe(`${captured.attemptId}:result`);

    const resultAudit = await readResultAudit(captured.attemptId);
    expect(resultAudit).not.toBeNull();
    expect(resultAudit?.result).toBe('success');
    expect(resultAudit?.decision).toBe('allow');
    // 对账以系统身份落审计，便于与用户/Agent 的执行区分。
    expect(resultAudit?.actorType).toBe('system');

    // 副作用恰好一次：订单一条、库存只预占一次。
    expect(await countOrdersByTrace([traceId])).toBe(1);
    await expect(readProduct()).resolves.toEqual({
      availableQty: INITIAL_AVAILABLE_QTY - 5000,
      reservedQty: 5000,
    });
    expect(await countIdempotencyRecords(CREATE_TOOL, idempotencyKey)).toBe(1);
    expect(
      await countIdempotencyRecords(
        EFFECTS_TOOL,
        scopedExecutorIdempotencyKey(CREATE_TOOL, idempotencyKey),
      ),
    ).toBe(1);

    // 终态尝试不会再被扫描：重复对账既不重复副作用，也不重复写结果审计。
    const again = await reconcileExecutions({
      tenantId: TENANT,
      effectsExecutor: executor,
      staleAfterMs: 0,
      now: reconciliationClock(),
    });
    expectReport(again, { scanned: 0, succeeded: 0, failed: 0, unknown: 0 });
    expect(await countOrdersByTrace([traceId])).toBe(1);
    const auditRows = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.count({ where: { tenantId: TENANT, eventId: `${captured.attemptId}:result` } }),
    );
    expect(auditRows).toBe(1);
  });

  it('执行器提交后超时：对账重放首次结果，不重复副作用', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const idempotencyKey = `idem_recovery_timeout_${traceId}`;
    const { token } = await previewAndApprove(traceId);

    const real = createInProcessCrmEffectsExecutor();
    const executorResults: EffectsExecuteResult[] = [];
    let calls = 0;
    const executor: EffectsExecutor = {
      async execute(input) {
        calls += 1;
        const result = await real.execute(input);
        executorResults.push(result);
        if (calls === 1) {
          // 副作用事务已提交，但响应在返回前台前丢失。
          throw new EffectsExecutionUnknownError('simulated timeout after commit');
        }
        return result;
      },
    };

    const first = (await orderExecuteCreate(
      agentPrincipal,
      { confirmation_token: token, idempotency_key: idempotencyKey },
      { traceId, secret, effectsExecutor: executor },
    )) as Envelope;

    expect(first.status).toBe('error');
    expect(first.error?.code).toBe('INTERNAL');
    expect(first.error?.message).toContain('reconciliation');

    const attempt = await readAttemptByKey(idempotencyKey);
    expect(attempt?.status).toBe('unknown');
    // 第一次执行已经真实提交了副作用。
    expect(await countOrdersByTrace([traceId])).toBe(1);
    await expect(readProduct()).resolves.toEqual({
      availableQty: INITIAL_AVAILABLE_QTY - 5000,
      reservedQty: 5000,
    });
    expect(await readResultAudit((attempt as { attemptId: string }).attemptId)).toBeNull();

    const report = await reconcileExecutions({
      tenantId: TENANT,
      effectsExecutor: executor,
      staleAfterMs: 0,
      now: reconciliationClock(),
    });
    expectReport(report, { scanned: 1, succeeded: 1, failed: 0, unknown: 0 });

    // 第二次调用命中执行器幂等记录：显式 replayed，且没有第二次副作用。
    expect(calls).toBe(2);
    expect(executorResults[0].replayed).toBeUndefined();
    expect(executorResults[1].replayed).toBe(true);
    expect(await countOrdersByTrace([traceId])).toBe(1);
    await expect(readProduct()).resolves.toEqual({
      availableQty: INITIAL_AVAILABLE_QTY - 5000,
      reservedQty: 5000,
    });

    const settled = await readAttempt((attempt as { attemptId: string }).attemptId);
    expect(settled.status).toBe('succeeded');
    expect(settled.resultAuditEventId).toBe(`${settled.attemptId}:result`);
    expect(await readResultAudit(settled.attemptId)).not.toBeNull();
    expect(await countIdempotencyRecords(CREATE_TOOL, idempotencyKey)).toBe(1);
    expect(
      await countIdempotencyRecords(
        EFFECTS_TOOL,
        scopedExecutorIdempotencyKey(CREATE_TOOL, idempotencyKey),
      ),
    ).toBe(1);
  });

  it('副作用成功但 Phase 3 未执行：对账补写结果审计，审计链校验通过', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const idempotencyKey = `idem_recovery_audit_${traceId}`;
    const { token } = await previewAndApprove(traceId);

    const captured = await captureUnknownAttempt(traceId, token, idempotencyKey);
    await markExecuting(captured.attemptId);

    // 模拟 Phase 2 已成功、Phase 3 事务未提交：用同一输入预先执行一次。
    const real = createInProcessCrmEffectsExecutor();
    const preExecuted = await real.execute(captured.input);
    expect(preExecuted.ok).toBe(true);
    expect(preExecuted.replayed).toBeUndefined();
    expect(await countOrdersByTrace([traceId])).toBe(1);
    expect(await readResultAudit(captured.attemptId)).toBeNull();
    expect((await readAttempt(captured.attemptId)).resultAuditEventId).toBeNull();

    const report = await reconcileExecutions({
      tenantId: TENANT,
      effectsExecutor: real,
      staleAfterMs: 0,
      now: reconciliationClock(),
    });
    expectReport(report, { scanned: 1, succeeded: 1, failed: 0, unknown: 0 });

    const settled = await readAttempt(captured.attemptId);
    expect(settled.status).toBe('succeeded');
    expect(settled.resultAuditEventId).toBe(`${captured.attemptId}:result`);

    const resultAudit = await readResultAudit(captured.attemptId);
    expect(resultAudit).not.toBeNull();
    expect(resultAudit?.result).toBe('success');

    // 重放没有产生第二条副作用或第二条结果审计。
    expect(await countOrdersByTrace([traceId])).toBe(1);
    const resultAuditCount = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.count({ where: { tenantId: TENANT, eventId: `${captured.attemptId}:result` } }),
    );
    expect(resultAuditCount).toBe(1);

    const chain = await withTenantScope(TENANT, (tx) => auditChain.verify(TENANT, tx));
    expect(chain.ok).toBe(true);

    // 结果事件是确定性的：再次对账不会追加新事件。
    await reconcileExecutions({
      tenantId: TENANT,
      effectsExecutor: real,
      staleAfterMs: 0,
      now: reconciliationClock(),
    });
    const afterRepeat = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.count({ where: { tenantId: TENANT, eventId: `${captured.attemptId}:result` } }),
    );
    expect(afterRepeat).toBe(1);
  });

  it('并发对账：条件结算只有一个胜者，副作用与结果审计各一次', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const idempotencyKey = `idem_recovery_race_${traceId}`;
    const { token } = await previewAndApprove(traceId);

    const captured = await captureUnknownAttempt(traceId, token, idempotencyKey);
    await markExecuting(captured.attemptId);

    const real = createInProcessCrmEffectsExecutor();
    let calls = 0;
    let release!: () => void;
    let bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bothInExecutor = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const executor: EffectsExecutor = {
      async execute(input) {
        calls += 1;
        if (calls === 2) bothStarted();
        // 两个对账都完成扫描并进入执行器后再放行，制造真实的结算竞争。
        await gate;
        return real.execute(input);
      },
    };

    const first = reconcileExecutions({
      tenantId: TENANT,
      effectsExecutor: executor,
      staleAfterMs: 0,
      now: reconciliationClock(),
    });
    const second = reconcileExecutions({
      tenantId: TENANT,
      effectsExecutor: executor,
      staleAfterMs: 0,
      now: reconciliationClock(),
    });

    await bothInExecutor;
    release();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expectReport(firstReport, { scanned: 1, succeeded: 1, failed: 0, unknown: 0 });
    expectReport(secondReport, { scanned: 1, succeeded: 1, failed: 0, unknown: 0 });

    // 执行器被调用两次，但幂等键相同：真实副作用只有一次。
    expect(calls).toBe(2);
    expect(await countOrdersByTrace([traceId])).toBe(1);
    await expect(readProduct()).resolves.toEqual({
      availableQty: INITIAL_AVAILABLE_QTY - 5000,
      reservedQty: 5000,
    });

    // 条件结算只有一个胜者：终态、结果审计、幂等记录都只有一份。
    const settled = await readAttempt(captured.attemptId);
    expect(settled.status).toBe('succeeded');
    expect(settled.resultAuditEventId).toBe(`${captured.attemptId}:result`);
    const auditCount = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.count({ where: { tenantId: TENANT, eventId: `${captured.attemptId}:result` } }),
    );
    expect(auditCount).toBe(1);
    expect(await countIdempotencyRecords(CREATE_TOOL, idempotencyKey)).toBe(1);
  });

  it('预审计失败：不调用执行器，也不创建执行尝试', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const idempotencyKey = `idem_recovery_preaudit_${traceId}`;
    const { token } = await previewAndApprove(traceId);

    let executorCalls = 0;
    const executor: EffectsExecutor = {
      async execute() {
        executorCalls += 1;
        return { ok: true, refs: {} };
      },
    };

    // Phase 1 的预审计写入失败 → 整个事务回滚，副作用绝不执行。
    const appendSpy = vi
      .spyOn(auditChain, 'append')
      .mockRejectedValueOnce(new Error('simulated audit store outage'));

    try {
      const result = (await orderExecuteCreate(
        agentPrincipal,
        { confirmation_token: token, idempotency_key: idempotencyKey },
        { traceId, secret, effectsExecutor: executor },
      )) as Envelope;

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('INTERNAL');
    } finally {
      appendSpy.mockRestore();
    }

    expect(executorCalls).toBe(0);
    expect(await countAttemptsByKey(idempotencyKey)).toBe(0);
    // 事务回滚把 attempt 与预审计一起带走；事务外补写的失败审计仍然存在。
    const pendingAudits = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.count({
        where: { tenantId: TENANT, traceId, tool: CREATE_TOOL, result: 'pending' },
      }),
    );
    expect(pendingAudits).toBe(0);
    const failureAudits = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.count({
        where: { tenantId: TENANT, traceId, tool: CREATE_TOOL, result: 'failure' },
      }),
    );
    expect(failureAudits).toBe(1);
  });

  it('并发同幂等键：一个执行、另一个 in-progress，副作用只发生一次', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const loserTrace = nextTrace();
    const idempotencyKey = `idem_recovery_concurrent_${traceId}`;
    const { token } = await previewAndApprove(traceId);

    const real = createInProcessCrmEffectsExecutor();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: EffectsExecutor = {
      async execute(input) {
        calls += 1;
        // 停在 Phase 2，让并发的第二个请求看到已提交的 executing attempt。
        await gate;
        return real.execute(input);
      },
    };

    const winner = orderExecuteCreate(
      agentPrincipal,
      { confirmation_token: token, idempotency_key: idempotencyKey },
      { traceId, secret, effectsExecutor: executor },
    );

    try {
      await waitFor(() => calls === 1);

      const loser = (await orderExecuteCreate(
        agentPrincipal,
        { confirmation_token: token, idempotency_key: idempotencyKey },
        { traceId: loserTrace, secret, effectsExecutor: executor },
      )) as Envelope;

      expect(loser.status).toBe('conflict');
      expect(loser.error?.code).toBe('CONFLICT');
      expect(loser.error?.message).toContain('in progress');
    } finally {
      release();
    }

    const winnerResult = (await winner) as Envelope & { data?: Record<string, unknown> };
    expect(winnerResult.status).toBe('ok');

    // 输家在 Phase 1 就被 attempt 状态挡下，没有第二次执行器调用。
    expect(calls).toBe(1);
    expect(await countOrdersByTrace([traceId, loserTrace])).toBe(1);
    await expect(readProduct()).resolves.toEqual({
      availableQty: INITIAL_AVAILABLE_QTY - 5000,
      reservedQty: 5000,
    });
    expect(await countAttemptsByKey(idempotencyKey)).toBe(1);
    const attempt = await readAttemptByKey(idempotencyKey);
    expect(attempt?.status).toBe('succeeded');
    expect(await countIdempotencyRecords(CREATE_TOOL, idempotencyKey)).toBe(1);
  });

  it('令牌重放换幂等键：CONFLICT，副作用只发生一次', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const firstKey = `idem_recovery_token_a_${traceId}`;
    const replayKey = `idem_recovery_token_b_${traceId}`;
    const { token } = await previewAndApprove(traceId);

    const first = (await orderExecuteCreate(
      agentPrincipal,
      { confirmation_token: token, idempotency_key: firstKey },
      { traceId, secret },
    )) as Envelope;
    expect(first.status).toBe('ok');

    const replay = (await orderExecuteCreate(
      agentPrincipal,
      { confirmation_token: token, idempotency_key: replayKey },
      { traceId, secret },
    )) as Envelope;
    expect(replay.status).toBe('conflict');
    expect(replay.error?.code).toBe('CONFLICT');
    expect(replay.error?.message).toMatch(/already been used/);

    expect(await countOrdersByTrace([traceId])).toBe(1);
    await expect(readProduct()).resolves.toEqual({
      availableQty: INITIAL_AVAILABLE_QTY - 5000,
      reservedQty: 5000,
    });
    expect(await countAttemptsByKey(firstKey)).toBe(1);
    // 重放请求在消费令牌之前就被挡下，不会创建第二个 attempt。
    expect(await countAttemptsByKey(replayKey)).toBe(0);
  });

  it('库存并发预占不超卖：两个并发订单只有一个成功，库存不为负', async () => {
    await resetFixture();
    const traceA = nextTrace();
    const traceB = nextTrace();
    const keyA = `idem_recovery_stock_a_${traceA}`;
    const keyB = `idem_recovery_stock_b_${traceB}`;
    const scenario = {
      ...SCENARIO,
      // 单笔 15000 可通过校验，两笔合计 30000 > 20000：并发下必须有一笔失败。
      items: [{ sku: SKU, quantity: 15000, unitPrice: 2 }],
    };

    const approvedA = await previewAndApprove(traceA, scenario);
    const approvedB = await previewAndApprove(traceB, scenario);

    const [resultA, resultB] = (await Promise.all([
      orderExecuteCreate(
        agentPrincipal,
        { confirmation_token: approvedA.token, idempotency_key: keyA },
        { traceId: traceA, secret },
      ),
      orderExecuteCreate(
        agentPrincipal,
        { confirmation_token: approvedB.token, idempotency_key: keyB },
        { traceId: traceB, secret },
      ),
    ])) as Envelope[];

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual(['conflict', 'ok']);

    // 核心安全断言：库存只被预占一次，且任何字段都没有被写成负数。
    const product = await readProduct();
    expect(product.availableQty).toBe(INITIAL_AVAILABLE_QTY - 15000);
    expect(product.reservedQty).toBe(15000);
    expect(product.availableQty).toBeGreaterThanOrEqual(0);
    expect(await countOrdersByTrace([traceA, traceB])).toBe(1);

    const succeeded = await withTenantScope(TENANT, (tx) =>
      tx.executionAttempt.count({
        where: {
          tenantId: TENANT,
          toolName: CREATE_TOOL,
          idempotencyKey: { in: [keyA, keyB] },
          status: 'succeeded',
        },
      }),
    );
    expect(succeeded).toBe(1);
  });
});

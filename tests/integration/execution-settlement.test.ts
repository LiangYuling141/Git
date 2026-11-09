import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma';
import type { EffectsExecutor, Envelope } from '@lymtrix/tef-core';
import { ok, scopedExecutorIdempotencyKey } from '@lymtrix/tef-mcp-kit';
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
 * 执行尝试结算的并发回归测试（真实数据库）。
 *
 * 需要 PostgreSQL：`TEF_DB_TESTS=1 npx vitest run tests/integration/execution-settlement.test.ts`。
 *
 * 覆盖两件 Task 4 依赖的保证：
 * 1. 结算必须带状态条件（executing/unknown）：另一个结算者已经推进终态时，
 *    前台不得覆盖结果、不得重复追加结果审计；
 * 2. succeeded 尝试的幂等记录缺失时返回 CONFLICT 要求对账，绝不伪造重放。
 */

const RUN_DB = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDb = RUN_DB ? describe : describe.skip;

const TENANT = 't_yiwu_demo';
const CUSTOMER = 'c_weiye_import';
const SKU = 'XMAS-BALL-01';

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
  return `tr_settle_${Date.now()}_${traceSeq}`;
}

async function resetFixture(): Promise<void> {
  await withTenantScope(TENANT, async (tx) => {
    await tx.product.updateMany({ where: { tenantId: TENANT }, data: { reservedQty: 0 } });
    await tx.product.updateMany({ where: { tenantId: TENANT, sku: SKU }, data: { availableQty: 20000 } });
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

describeDb('执行尝试结算（真实数据库）', () => {
  beforeAll(async () => {
    secret = loadTokenSecret();
    await resetFixture();

    const resolved = await resolveTenantContext('admin', prisma, TENANT);
    agentPrincipal = { ...resolved, sessionId: 's_settle_agent', clientKind: 'agent' };
    humanPrincipal = { ...resolved, sessionId: 's_settle_human', clientKind: 'confirmation-ui' };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('并发结算：对账已先行推进终态时，前台不得覆盖结果或重复写结果审计', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const preview = (await orderPreviewCreate(agentPrincipal, SCENARIO, { traceId, secret })) as Envelope;
    expect(preview.status).toBe('needs_confirmation');
    const token = preview.confirmationToken as string;
    const approved = await confirmationApprove(humanPrincipal, { confirmation_token: token }, { traceId, secret });
    expect(approved.status).toBe('ok');

    const idempotencyKey = `idem_settle_race_${traceId}`;
    // 模拟 Task 4 对账抢先结算：效果已确认，结果响应已写入幂等记录。
    const reconciledResponse = ok(
      { orderId: 'order_from_reconciliation', status: 'confirmed' },
      { risk: 'L2', reasons: [], auditId: 'audit_from_reconciliation', traceId },
    );

    let executorKey: string | undefined;
    let settledAttemptId: string | undefined;

    const executor: EffectsExecutor = {
      async execute(input) {
        executorKey = input.idempotencyKey;
        settledAttemptId = await withTenantScope(TENANT, async (tx) => {
          const attempt = await tx.executionAttempt.findUniqueOrThrow({
            where: {
              tenantId_toolName_idempotencyKey: {
                tenantId: TENANT,
                toolName: 'order.execute_create',
                idempotencyKey,
              },
            },
          });
          await tx.executionAttempt.update({
            where: { attemptId: attempt.attemptId },
            data: {
              status: 'succeeded',
              result: reconciledResponse as unknown as Prisma.InputJsonValue,
              settledAt: new Date(),
            },
          });
          await tx.idempotencyRecord.create({
            data: {
              tenantId: TENANT,
              toolName: 'order.execute_create',
              idempotencyKey,
              status: 'completed',
              response: reconciledResponse as unknown as object,
            },
          });
          return attempt.attemptId;
        });
        // 前台看到的执行结果此时已经过时：attempt 已被对账结算。
        return { ok: true, refs: {} };
      },
    };

    const result = (await orderExecuteCreate(
      agentPrincipal,
      { confirmation_token: token, idempotency_key: idempotencyKey },
      { traceId, secret, effectsExecutor: executor },
    )) as Envelope & { data?: Record<string, unknown> };

    // 执行器收到的幂等键必须按工具作用域派生，不能是裸业务 key。
    expect(executorKey).toBe(scopedExecutorIdempotencyKey('order.execute_create', idempotencyKey));
    expect(settledAttemptId).toBeTruthy();

    // 条件结算命中 0 行：返回对账写入的幂等记录，而不是前台自己构造的响应。
    expect(result.status).toBe('ok');
    expect(result.data?.replayed).toBe(true);
    expect(result.data?.orderId).toBe('order_from_reconciliation');

    const attempt = await withTenantScope(TENANT, (tx) =>
      tx.executionAttempt.findUniqueOrThrow({ where: { attemptId: settledAttemptId as string } }),
    );
    expect(attempt.status).toBe('succeeded');
    expect(attempt.result).toMatchObject({
      status: 'ok',
      data: { orderId: 'order_from_reconciliation' },
    });

    // 前台没有结算权，因此不得补写 `${attemptId}:result` 审计。
    const resultAudit = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.findFirst({ where: { eventId: `${settledAttemptId}:result` } }),
    );
    expect(resultAudit).toBeNull();
    // Phase 1 的预审计照常存在：副作用意图在结算竞争之前已经提交。
    const preAudit = await withTenantScope(TENANT, (tx) =>
      tx.auditEvent.findFirst({ where: { eventId: `${settledAttemptId}:pre` } }),
    );
    expect(preAudit).not.toBeNull();
  });

  it('succeeded 但幂等记录缺失：返回 CONFLICT 要求对账，不伪造重放', async () => {
    const traceId = nextTrace();
    const idempotencyKey = `idem_stale_${traceId}`;
    const attemptId = `att_stale_${traceId}`;

    await withTenantScope(TENANT, async (tx) => {
      await tx.executionAttempt.create({
        data: {
          attemptId,
          tenantId: TENANT,
          traceId,
          previewId: `pv_stale_${traceId}`,
          contract: 'create_order',
          contractVersion: '1.0',
          intentHash: `ih_stale_${traceId}`,
          toolName: 'order.execute_create',
          idempotencyKey,
          status: 'succeeded',
          risk: 'L2',
          effects: [],
          result: { status: 'ok', data: { orderId: 'stale_order' } } as unknown as Prisma.InputJsonValue,
          settledAt: new Date(),
        },
      });
    });

    try {
      const result = await orderExecuteCreate(
        agentPrincipal,
        // attempt 短路发生在令牌消费之前，因此这里不需要真实令牌。
        { confirmation_token: 'ct_not_consumed_before_attempt_check', idempotency_key: idempotencyKey },
        { traceId, secret },
      );

      expect(result.status).toBe('conflict');
      expect(result.error?.code).toBe('CONFLICT');
      expect(result.error?.message).toContain('idempotency record is missing');
      expect(result.error?.message).toContain('reconciliation required');
    } finally {
      await withTenantScope(TENANT, (tx) => tx.executionAttempt.deleteMany({ where: { attemptId } }));
    }
  });
});

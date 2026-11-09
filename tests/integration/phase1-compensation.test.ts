import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentTurn } from '@/agent-runtime/runtime';
import { prisma } from '@/lib/prisma';
import { connectTefClient, type Principal, type TefClientSession } from '@/mcp-server';
import { resolveTenantContext } from '@/tef/tenant';
import { taskStateStore } from '@/tef/task-state';
import { withTenantScope } from '@/tef/tenant-scope';
import { loadTokenSecret } from '@/tef/token';
import type { Envelope, TaskState } from '@/tef/types';

/**
 * Phase 1 补偿闭环集成测试。
 *
 * 需要真实 PostgreSQL：`TEF_DB_TESTS=1 npx vitest run tests/integration`。
 * 默认跳过，这样没有数据库的环境不会因为连不上而失败。
 *
 * 覆盖：创建 → 批准 → 执行 → 预览补偿 → 批准 → 执行 → 状态恢复 → 审计回放，
 * 以及未批准执行、令牌重放、跨租户、已收款、已补偿等边界。
 */

const RUN_DB = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDb = RUN_DB ? describe : describe.skip;

const TENANT = 't_yiwu_demo';
const OTHER_TENANT = 't_e2e_compensation_other';
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
  return `tr_comp_${Date.now()}_${traceSeq}`;
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
  // 自然语言用例走 L1 小额订单，使用 c_vip（锦绣家居）；同样要复位，
  // 否则上一次失败留下的占用会让后续运行失败。
  await prisma.customer.updateMany({
    where: { tenantId: TENANT, id: 'c_vip' },
    data: {
      creditUsed: 0,
      overdueDays: 0,
      customerType: 'vip',
      isHighRisk: false,
      status: 'active',
    },
  });
}

async function ensureOtherTenant(): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: OTHER_TENANT },
    create: { id: OTHER_TENANT, name: '补偿测试对照租户', slug: 'compensation-other', thresholds: { amountL2Threshold: 5000 } },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: 'compensation-outsider' },
    create: { id: 'compensation-outsider', userName: 'Compensation Outsider', tenantId: OTHER_TENANT },
    update: { tenantId: OTHER_TENANT },
  });
  await prisma.tenantMember.upsert({
    where: { tenantId_userId: { tenantId: OTHER_TENANT, userId: 'compensation-outsider' } },
    create: { tenantId: OTHER_TENANT, userId: 'compensation-outsider', role: 'owner' },
    update: { role: 'owner' },
  });
}

async function createConfirmedOrder(
  agent: TefClientSession,
  human: TefClientSession,
  traceId: string,
): Promise<{ orderId: string; token: string; idempotencyKey: string }> {
  const preview = (await agent.callTool('order.preview_create', SCENARIO)) as Envelope;
  expect(preview.status).toBe('needs_confirmation');
  expect(preview.confirmationToken).toMatch(/^ct_/);

  const token = preview.confirmationToken as string;
  const approved = await human.callTool('confirmation.approve', { confirmation_token: token });
  expect(approved.status).toBe('ok');

  const idempotencyKey = `idem_comp_create_${traceId}`;
  const executed = (await agent.callTool('order.execute_create', {
    confirmation_token: token,
    idempotency_key: idempotencyKey,
  })) as Envelope & { data: Record<string, unknown> };
  expect(executed.status).toBe('ok');
  return { orderId: executed.data.orderId as string, token, idempotencyKey };
}

async function previewAndApproveCompensation(
  agent: TefClientSession,
  human: TefClientSession,
  orderId: string,
  traceId: string,
): Promise<{ token: string; preview: Envelope }> {
  const preview = (await agent.callTool('order.preview_compensate', {
    orderId,
    reason: `集成测试取消 ${traceId}`,
  })) as Envelope;
  expect(preview.status).toBe('needs_confirmation');
  expect(preview.risk).toBe('L2');
  expect(preview.confirmationToken).toMatch(/^ct_/);

  const approved = await human.callTool('confirmation.approve', {
    confirmation_token: preview.confirmationToken as string,
  });
  expect(approved.status).toBe('ok');
  return { token: preview.confirmationToken as string, preview };
}

describeDb('Phase 1 补偿闭环（真实数据库）', () => {
  beforeAll(async () => {
    secret = loadTokenSecret();
    await ensureOtherTenant();
    await resetFixture();

    const resolved = await resolveTenantContext('admin', prisma, TENANT);
    agentPrincipal = { ...resolved, sessionId: 's_comp_agent', clientKind: 'agent' };
    humanPrincipal = { ...resolved, sessionId: 's_comp_human', clientKind: 'confirmation-ui' };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('完整补偿：创建 → 批准 → 执行 → 预览补偿 → 批准 → 执行 → 状态恢复 → 审计回放', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const agent = await connectTefClient({ principal: agentPrincipal, traceId, secret });
    const human = await connectTefClient({ principal: humanPrincipal, traceId, secret });

    try {
      const { orderId } = await createConfirmedOrder(agent, human, traceId);

      const orderBefore = await prisma.order.findFirst({ where: { id: orderId, tenantId: TENANT }, include: { payments: true } });
      expect(orderBefore?.status).toBe('confirmed');
      expect(orderBefore?.payments).toHaveLength(2);

      const { token, preview } = await previewAndApproveCompensation(agent, human, orderId, traceId);
      expect(preview.reasons?.join(' ')).toContain('compensation_requires_human_approval');
      const labels = preview.diff?.map((entry) => entry.label ?? '') ?? [];
      expect(labels[0]).toMatch(/^取消订单 SO-/);
      expect(labels.slice(1)).toEqual([
        '作废定金收款计划 ¥3000.00',
        '作废余款收款计划 ¥7000.00',
        '释放库存 圣诞球 直径6cm 混色 5000个',
        '归还信用额度 ¥7000.00',
      ]);

      const compensated = (await agent.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: `idem_comp_exec_${traceId}`,
      })) as Envelope & { data: Record<string, unknown> };
      expect(compensated.status).toBe('ok');
      expect(compensated.data.compensated).toBe(true);
      expect(compensated.data.orderId).toBe(orderId);

      const orderAfter = await prisma.order.findFirst({ where: { id: orderId, tenantId: TENANT }, include: { payments: true } });
      expect(orderAfter?.status).toBe('cancelled');
      expect(orderAfter?.payments.map((payment) => payment.status)).toEqual(['voided', 'voided']);

      const product = await withTenantScope(TENANT, (tx) =>
        tx.product.findFirst({ where: { tenantId: TENANT, sku: SKU } }),
      );
      expect(product?.availableQty).toBe(20000);
      expect(product?.reservedQty).toBe(0);

      const customer = await prisma.customer.findFirst({ where: { id: CUSTOMER, tenantId: TENANT } });
      expect(customer?.creditUsed).toBe(0);

      const trace = (await agent.callTool('audit.trace', { traceId })) as Envelope & {
        data: { events: Array<{ tool: string; result: string; decision: string }>; chain: { ok: boolean } };
      };
      expect(trace.data.chain.ok).toBe(true);
      expect(trace.data.events.map((event) => event.tool)).toEqual(
        expect.arrayContaining([
          'order.preview_create',
          'confirmation.approve',
          'order.execute_create',
          'order.preview_compensate',
          'order.execute_compensate',
        ]),
      );
      // Phase C 起一次执行会产生两条事件：预审计 pending 与结果审计 compensated。
      // 这里按结果过滤，保留“成功补偿必须留下 allow/compensated 审计”的断言。
      const compensationEvent = trace.data.events.find(
        (event) => event.tool === 'order.execute_compensate' && event.result === 'compensated',
      );
      expect(compensationEvent?.result).toBe('compensated');
      expect(compensationEvent?.decision).toBe('allow');
    } finally {
      await agent.close();
      await human.close();
    }
  });

  it('未批准执行补偿 → NEEDS_CONFIRMATION，且不产生任何写入', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const agent = await connectTefClient({ principal: agentPrincipal, traceId, secret });
    const human = await connectTefClient({ principal: humanPrincipal, traceId, secret });

    try {
      const { orderId } = await createConfirmedOrder(agent, human, traceId);
      const preview = (await agent.callTool('order.preview_compensate', { orderId })) as Envelope;
      expect(preview.status).toBe('needs_confirmation');

      const attempted = (await agent.callTool('order.execute_compensate', {
        confirmation_token: preview.confirmationToken as string,
        idempotency_key: `idem_comp_unapproved_${traceId}`,
      })) as Envelope;
      expect(attempted.status).toBe('error');
      expect(attempted.error?.code).toBe('NEEDS_CONFIRMATION');

      const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: TENANT } });
      expect(order?.status).toBe('confirmed');
    } finally {
      await agent.close();
      await human.close();
    }
  });

  it('幂等：同一补偿幂等键重复请求不重复释放', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const agent = await connectTefClient({ principal: agentPrincipal, traceId, secret });
    const human = await connectTefClient({ principal: humanPrincipal, traceId, secret });

    try {
      const { orderId } = await createConfirmedOrder(agent, human, traceId);
      const { token } = await previewAndApproveCompensation(agent, human, orderId, traceId);
      const key = `idem_comp_replay_${traceId}`;

      const first = (await agent.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: key,
      })) as Envelope & { data: Record<string, unknown> };
      expect(first.status).toBe('ok');

      const second = (await agent.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: key,
      })) as Envelope & { data: Record<string, unknown> };
      expect(second.status).toBe('ok');
      expect(second.data.replayed).toBe(true);

      const product = await withTenantScope(TENANT, (tx) =>
        tx.product.findFirst({ where: { tenantId: TENANT, sku: SKU } }),
      );
      expect(product?.reservedQty).toBe(0);
      expect(product?.availableQty).toBe(20000);
    } finally {
      await agent.close();
      await human.close();
    }
  });

  it('令牌重放：换一个幂等键也不能补偿两次', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const agent = await connectTefClient({ principal: agentPrincipal, traceId, secret });
    const human = await connectTefClient({ principal: humanPrincipal, traceId, secret });

    try {
      const { orderId } = await createConfirmedOrder(agent, human, traceId);
      const { token } = await previewAndApproveCompensation(agent, human, orderId, traceId);

      const first = await agent.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: `idem_comp_a_${traceId}`,
      });
      expect(first.status).toBe('ok');

      const replay = (await agent.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: `idem_comp_b_${traceId}`,
      })) as Envelope;
      expect(replay.status).toBe('conflict');
      expect(replay.error?.code).toBe('CONFLICT');
      expect(replay.error?.message).toMatch(/already been used/);
    } finally {
      await agent.close();
      await human.close();
    }
  });

  it('跨租户使用补偿令牌被拒，且不消耗令牌', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const agent = await connectTefClient({ principal: agentPrincipal, traceId, secret });
    const human = await connectTefClient({ principal: humanPrincipal, traceId, secret });

    const outsiderResolved = await resolveTenantContext('compensation-outsider', prisma, OTHER_TENANT);
    const outsider: Principal = { ...outsiderResolved, sessionId: 's_comp_outsider', clientKind: 'agent' };
    const outsiderSession = await connectTefClient({ principal: outsider, traceId: nextTrace(), secret });

    try {
      const { orderId } = await createConfirmedOrder(agent, human, traceId);
      const { token } = await previewAndApproveCompensation(agent, human, orderId, traceId);

      const stolen = (await outsiderSession.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: `idem_comp_stolen_${traceId}`,
      })) as Envelope;
      expect(stolen.status).toBe('error');
      expect(stolen.error?.code).toBe('PERMISSION_DENIED');

      const legit = (await agent.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: `idem_comp_legit_${traceId}`,
      })) as Envelope;
      expect(legit.status).toBe('ok');
    } finally {
      await agent.close();
      await human.close();
      await outsiderSession.close();
    }
  });

  it('已补偿订单再次预览补偿 → blocked', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const agent = await connectTefClient({ principal: agentPrincipal, traceId, secret });
    const human = await connectTefClient({ principal: humanPrincipal, traceId, secret });

    try {
      const { orderId } = await createConfirmedOrder(agent, human, traceId);
      const { token } = await previewAndApproveCompensation(agent, human, orderId, traceId);
      const executed = await agent.callTool('order.execute_compensate', {
        confirmation_token: token,
        idempotency_key: `idem_comp_already_${traceId}`,
      });
      expect(executed.status).toBe('ok');

      const again = (await agent.callTool('order.preview_compensate', { orderId })) as Envelope;
      expect(again.status).toBe('blocked');
      expect(again.reasons?.join(' ')).toContain('ORDER_NOT_COMPENSABLE');
    } finally {
      await agent.close();
      await human.close();
    }
  });

  it('已有收款完成 → blocked(PAYMENT_ALREADY_COLLECTED)', async () => {
    await resetFixture();
    const traceId = nextTrace();
    const agent = await connectTefClient({ principal: agentPrincipal, traceId, secret });
    const human = await connectTefClient({ principal: humanPrincipal, traceId, secret });

    try {
      const { orderId } = await createConfirmedOrder(agent, human, traceId);
      await withTenantScope(TENANT, async (tx) => {
        await tx.payment.updateMany({ where: { tenantId: TENANT, orderId }, data: { status: 'completed' } });
      });

      const preview = (await agent.callTool('order.preview_compensate', { orderId })) as Envelope;
      expect(preview.status).toBe('blocked');
      expect(preview.reasons?.join(' ')).toContain('PAYMENT_ALREADY_COLLECTED');
    } finally {
      await agent.close();
      await human.close();
    }
  });

  it('自然语言补偿："取消刚才那单" → L2 预览 → 人工确认 → 执行 → 状态恢复', async () => {
    await resetFixture();
    const conversationId = `conv_comp_${Date.now()}`;

    async function turn(conversationId: string, message: string, state?: TaskState) {
      const taskState = state ?? (await taskStateStore.loadOrCreate(TENANT, conversationId, 'admin'));
      const inFlight = !['completed', 'failed', 'compensated', 'compensation_failed'].includes(taskState.status);
      const traceId = inFlight && taskState.traceId ? taskState.traceId : nextTrace();
      const result = await runAgentTurn({
        message,
        conversationId,
        principal: {
          tenantId: agentPrincipal.tenantId,
          userId: agentPrincipal.userId,
          sessionId: agentPrincipal.sessionId,
          role: agentPrincipal.role,
        },
        taskState,
        traceId,
        secret,
        connectSession: connectTefClient,
      });
      const persisted = await taskStateStore.update(
        TENANT,
        conversationId,
        { ...result.patch, traceId },
        taskState.version,
      );
      return { result, taskState: persisted, traceId };
    }

    // 1. L1 小额订单：Runtime 直接执行，activeOrderId 落到 TaskState
    const created = await turn(conversationId, '给锦绣家居下单 100 个圣诞球 单价 2 块');
    expect(created.result.status).toBe('completed');
    expect(created.taskState.activeOrderId).toBeTruthy();
    const orderId = created.taskState.activeOrderId as string;

    // 2. 自然语言补偿：识别为 compensate_order，先预览，L2 等待人工确认
    const requested = await turn(conversationId, '把刚才那单取消掉', created.taskState);
    expect(requested.result.status).toBe('awaiting_confirmation');
    expect(requested.taskState.pendingPreview?.contract).toBe('compensate_order');
    expect(requested.result.envelope?.risk).toBe('L2');
    expect(requested.result.envelope?.confirmationToken).toMatch(/^ct_/);
    expect(requested.taskState.idempotencyKey).toBeTruthy();

    // 3. 人工批准
    const human = await connectTefClient({
      principal: humanPrincipal,
      traceId: requested.traceId,
      secret,
    });
    try {
      const approved = await human.callTool('confirmation.approve', {
        confirmation_token: requested.result.envelope?.confirmationToken as string,
      });
      expect(approved.status).toBe('ok');

      // 4. 执行补偿：复用 TaskState 里持久化的幂等键
      const agent = await connectTefClient({
        principal: agentPrincipal,
        traceId: requested.traceId,
        secret,
      });
      try {
        const executed = (await agent.callTool('order.execute_compensate', {
          confirmation_token: requested.result.envelope?.confirmationToken as string,
          idempotency_key: requested.taskState.idempotencyKey as string,
        })) as Envelope & { data: Record<string, unknown> };
        expect(executed.status).toBe('ok');
        expect(executed.data.compensated).toBe(true);
      } finally {
        await agent.close();
      }
    } finally {
      await human.close();
    }

    const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: TENANT } });
    expect(order?.status).toBe('cancelled');

    const product = await withTenantScope(TENANT, (tx) =>
      tx.product.findFirst({ where: { tenantId: TENANT, sku: SKU } }),
    );
    expect(product?.availableQty).toBe(20000);
    expect(product?.reservedQty).toBe(0);

    const customer = await prisma.customer.findFirst({ where: { id: 'c_vip', tenantId: TENANT } });
    expect(customer?.creditUsed).toBe(0);
  });
});

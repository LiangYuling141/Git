import { describe, expect, it } from 'vitest';
import type { EffectsExecuteRequest, EffectsExecuteResult } from '@lymtrix/tef-core';
import { withTenantScope } from '@lymtrix/tef-mcp-kit/tenant-scope';
import { prisma } from '@/lib/prisma';
import {
  createInProcessCrmEffectsExecutor,
  executeCrmEffectsInProcess,
} from './effects-executor';

/**
 * 进程内 effects 执行器（真实数据库）。
 *
 * 需要 PostgreSQL：`TEF_DB_TESTS=1 npx vitest run verticals/crm-erp-mcp`。
 * 用例复用内部网关集成测试的商品夹具，每个用例结束后复位库存并删除幂等记录。
 */

const RUN_DB = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDb = RUN_DB ? describe : describe.skip;

const TENANT = 't_yiwu_demo';
const TOOL_NAME = 'internal.effects.execute';
const PRODUCT = 'p_xmas_ball';
const PRODUCT_AVAILABLE_QTY = 20000;

let keySeq = 0;

/** 每次生成唯一幂等键，避免历史遗留记录把重放用例变成假阳性。 */
function effectsKey(): string {
  keySeq += 1;
  return `executor_itest_${Date.now()}_${keySeq}`;
}

function updateProductRequest(idempotencyKey: string, delta: number): EffectsExecuteRequest {
  return {
    tenantId: TENANT,
    idempotencyKey,
    previewId: 'pv_executor_test',
    traceId: 'tr_executor_test',
    effects: [
      {
        type: 'update',
        entity: 'product',
        as: 'product',
        target: PRODUCT,
        payload: {},
        increment: { availableQty: -delta, reservedQty: delta },
      },
    ],
  };
}

async function readProduct(): Promise<{ availableQty: number; reservedQty: number }> {
  return withTenantScope(TENANT, (tx) =>
    tx.product.findFirstOrThrow({
      where: { id: PRODUCT, tenantId: TENANT },
      select: { availableQty: true, reservedQty: true },
    }),
  );
}

async function readIdempotencyRecord(idempotencyKey: string) {
  return withTenantScope(TENANT, (tx) =>
    tx.idempotencyRecord.findFirst({
      where: { tenantId: TENANT, toolName: TOOL_NAME, idempotencyKey },
    }),
  );
}

async function resetFixtures(idempotencyKey: string): Promise<void> {
  await withTenantScope(TENANT, async (tx) => {
    await tx.product.updateMany({
      where: { id: PRODUCT, tenantId: TENANT },
      data: { availableQty: PRODUCT_AVAILABLE_QTY, reservedQty: 0 },
    });
    await tx.idempotencyRecord.deleteMany({
      where: { tenantId: TENANT, toolName: TOOL_NAME, idempotencyKey },
    });
  });
}

async function setAvailableQty(availableQty: number): Promise<void> {
  await withTenantScope(TENANT, (tx) =>
    tx.product.updateMany({
      where: { id: PRODUCT, tenantId: TENANT },
      data: { availableQty, reservedQty: 0 },
    }),
  );
}

/**
 * 等到至少 expected 个 UPDATE products 会话阻塞在数据库锁上。
 *
 * 多个会话排队等同一行锁时，`pg_blocking_pids` 只报告队列前一个事务，
 * 因此不能只按行锁持有者的 pid 计数；按等待事件与语句特征统计更稳。
 */
async function waitForBlockedSessions(expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%update%'
        AND query ILIKE '%products%'
    `;
    if (Number(rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('executor transactions did not block on the product row lock in time');
}

describeDb('执行器：进程内 CRM effects', () => {
  it('执行成功写入幂等记录；同 key 重放返回首次响应且不重复写库存', async () => {
    const idempotencyKey = effectsKey();
    const input = updateProductRequest(idempotencyKey, 3);

    try {
      await resetFixtures(idempotencyKey);

      // 首次执行走端口工厂，覆盖 createInProcessCrmEffectsExecutor 的接线。
      const executor = createInProcessCrmEffectsExecutor();
      const first = await executor.execute(input);
      expect(first).toEqual({
        ok: true,
        refs: { product: { id: PRODUCT, tenantId: TENANT } },
      });
      await expect(readProduct()).resolves.toEqual({
        availableQty: PRODUCT_AVAILABLE_QTY - 3,
        reservedQty: 3,
      });

      const record = await readIdempotencyRecord(idempotencyKey);
      expect(record?.status).toBe('completed');

      const replay = await executeCrmEffectsInProcess(input);
      expect(replay).toEqual({ ...first, replayed: true });

      // 重放命中幂等记录，不再执行 effects，库存保持首次执行后的值。
      await expect(readProduct()).resolves.toEqual({
        availableQty: PRODUCT_AVAILABLE_QTY - 3,
        reservedQty: 3,
      });
    } finally {
      await resetFixtures(idempotencyKey);
    }
  });

  it('目标不存在时返回结构化 CONFLICT，事务回滚且不写幂等记录', async () => {
    const idempotencyKey = effectsKey();

    try {
      const result = await executeCrmEffectsInProcess({
        tenantId: TENANT,
        idempotencyKey,
        previewId: '',
        traceId: '',
        effects: [
          {
            type: 'update',
            entity: 'product',
            target: 'p_missing',
            payload: {},
            increment: { availableQty: 0 },
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.refs).toEqual({});
      expect(result.error?.code).toBe('CONFLICT');
      expect(result.error?.message).toContain('p_missing');
      // effects 失败时事务整体回滚：幂等记录不得落库，调用方可用同一 key 重试。
      await expect(readIdempotencyRecord(idempotencyKey)).resolves.toBeNull();
    } finally {
      await resetFixtures(idempotencyKey);
    }
  });

  it('并发同 key 只执行一次：一个首次响应，另一个按重放返回', async () => {
    const idempotencyKey = effectsKey();
    const input = updateProductRequest(idempotencyKey, 4);

    try {
      await resetFixtures(idempotencyKey);

      // 两个调用同时进入：都读不到幂等记录，先提交者成功；后提交者在唯一
      // 索引上得到 P2002，事务回滚后由执行器读取先提交者的记录重放。
      const results = await Promise.all([
        executeCrmEffectsInProcess(input),
        executeCrmEffectsInProcess(input),
      ]);

      expect(results.filter((entry) => entry.ok)).toHaveLength(2);
      expect(results.filter((entry) => entry.replayed === true)).toHaveLength(1);
      expect(results.filter((entry) => entry.replayed !== true)).toHaveLength(1);

      // 失败方的事务回滚了自己的库存扣减，净效果只应用一次。
      await expect(readProduct()).resolves.toEqual({
        availableQty: PRODUCT_AVAILABLE_QTY - 4,
        reservedQty: 4,
      });
    } finally {
      await resetFixtures(idempotencyKey);
    }
  });

  it('并发同 key 且库存刚好够一次：守卫冲突方重放已提交结果，不重复扣减', async () => {
    const idempotencyKey = effectsKey();
    const delta = 4;
    const input = updateProductRequest(idempotencyKey, delta);

    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishPid!: (pid: number) => void;
    const holderPid = new Promise<number>((resolve) => {
      publishPid = resolve;
    });
    let holder: Promise<unknown> | undefined;
    let first: Promise<EffectsExecuteResult> | undefined;
    let second: Promise<EffectsExecuteResult> | undefined;

    try {
      await resetFixtures(idempotencyKey);
      // 库存刚好够一次扣减：第二个提交者必然撞上非负守卫。
      await setAvailableQty(delta);

      holder = withTenantScope(TENANT, async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        // 占住产品行：两个执行器都会先完成幂等检查，再一起排队等待这把行锁。
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${PRODUCT} AND "tenantId" = ${TENANT} FOR UPDATE`;
        publishPid(backend.pid);
        await releaseLock;
      });

      await holderPid;
      first = executeCrmEffectsInProcess(input);
      second = executeCrmEffectsInProcess(input);

      // 两个事务都已通过幂等检查并卡在库存更新上，释放锁即可稳定复现竞态：
      // 先提交者扣减成功，后提交者的非负守卫命中 0 行并抛 CONFLICT。
      await waitForBlockedSessions(2);
      release();

      const [a, b] = await Promise.all([first, second]);
      await holder;

      // 守卫失败方在新事务中读到先提交者的幂等记录，按重放返回而非 CONFLICT。
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect([a.replayed, b.replayed].filter((value) => value === true)).toHaveLength(1);

      // 净效果只应用一次，库存没有被写成负数。
      await expect(readProduct()).resolves.toEqual({ availableQty: 0, reservedQty: delta });
      await expect(readIdempotencyRecord(idempotencyKey)).resolves.not.toBeNull();
    } finally {
      release();
      await holder?.catch(() => undefined);
      // 失败路径下先等执行器事务结束，避免并发写库干扰后续用例的夹具复位。
      await Promise.allSettled([first, second]);
      await resetFixtures(idempotencyKey);
    }
  });
});

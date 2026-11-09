import { describe, expect, it } from 'vitest';
import type { EffectsExecuteRequest } from '@lymtrix/tef-core';
import { withTenantScope } from '@lymtrix/tef-mcp-kit/tenant-scope';
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
});

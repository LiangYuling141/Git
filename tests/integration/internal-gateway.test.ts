import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/internal/v1/query/route';
import { POST as effectsPost } from '@/app/api/internal/v1/effects/execute/route';
import { withTenantScope } from '@/tef/tenant-scope';

/**
 * 内部网关集成测试（query 与 effects:execute）。
 *
 * 需要真实 PostgreSQL：`TEF_DB_TESTS=1 npx vitest run tests/integration/internal-gateway.test.ts`。
 * query 用例只读种子数据；effects 用例会写入 product 与幂等记录，
 * 因此每个改动用例结束后复位夹具。
 */

const RUN_DB = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDb = RUN_DB ? describe : describe.skip;

const TENANT = 't_yiwu_demo';
const OTHER_TENANT = 't_e2e_other';
const CUSTOMER = 'c_weiye_import';
const TOKEN = 'test-internal-token';

let savedToken: string | undefined;
let savedEffectsEnabled: string | undefined;

function request(body: string, token: string | null = TOKEN): Request {
  return new Request('http://localhost/api/internal/v1/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

function query(body: unknown, token: string | null = TOKEN): Request {
  return request(JSON.stringify(body), token);
}

// -----------------------------------------------------------------------------
// effects:execute 夹具
// -----------------------------------------------------------------------------

const TOOL_NAME = 'internal.effects.execute';
const PRODUCT = 'p_xmas_ball';
const PRODUCT_AVAILABLE_QTY = 20000;

function effectsRequest(body: unknown, token: string | null = TOKEN): Request {
  return new Request('http://localhost/api/internal/v1/effects/execute', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

let effectsSeq = 0;

/** 每次运行生成唯一幂等键，避免历史遗留记录把重放用例变成假阳性。 */
function effectsKey(): string {
  effectsSeq += 1;
  return `itest_effects_${Date.now()}_${effectsSeq}`;
}

async function readProduct(): Promise<{ availableQty: number; reservedQty: number }> {
  return withTenantScope(TENANT, (tx) =>
    tx.product.findFirstOrThrow({
      where: { id: PRODUCT, tenantId: TENANT },
      select: { availableQty: true, reservedQty: true },
    }),
  );
}

async function resetProductFixture(): Promise<void> {
  await withTenantScope(TENANT, async (tx) => {
    await tx.product.updateMany({
      where: { id: PRODUCT, tenantId: TENANT },
      data: { availableQty: PRODUCT_AVAILABLE_QTY, reservedQty: 0 },
    });
  });
}

async function deleteIdempotencyRecord(key: string, tenantId: string = TENANT): Promise<void> {
  await withTenantScope(tenantId, async (tx) => {
    await tx.idempotencyRecord.deleteMany({
      where: { tenantId, toolName: TOOL_NAME, idempotencyKey: key },
    });
  });
}

describeDb('内部 HTTP 网关（真实数据库）', () => {
  beforeAll(() => {
    savedToken = process.env.TEF_CRM_SERVICE_TOKEN;
    savedEffectsEnabled = process.env.TEF_CRM_EFFECTS_ENABLED;
    process.env.TEF_CRM_SERVICE_TOKEN = TOKEN;
    // effects 端点默认关闭；本文件验证的是启用后的行为，单独用例再覆盖关闭态。
    process.env.TEF_CRM_EFFECTS_ENABLED = '1';
  });

  afterAll(() => {
    if (savedToken === undefined) {
      delete process.env.TEF_CRM_SERVICE_TOKEN;
    } else {
      process.env.TEF_CRM_SERVICE_TOKEN = savedToken;
    }
    if (savedEffectsEnabled === undefined) {
      delete process.env.TEF_CRM_EFFECTS_ENABLED;
    } else {
      process.env.TEF_CRM_EFFECTS_ENABLED = savedEffectsEnabled;
    }
  });

  it('缺少 Authorization 时返回 401', async () => {
    const response = await POST(
      query({ tenantId: TENANT, operation: 'crm.customer.get', params: { customerId: CUSTOMER } }, null),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('Authorization 令牌错误时返回 401', async () => {
    const response = await POST(
      query({ tenantId: TENANT, operation: 'crm.customer.get', params: { customerId: CUSTOMER } }, 'wrong-token'),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('customer.get 使用种子客户返回快照', async () => {
    const response = await POST(
      query({ tenantId: TENANT, operation: 'crm.customer.get', params: { customerId: CUSTOMER } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string } | null };
    expect(body.data?.id).toBe(CUSTOMER);
  });

  it('customer.get 缺少 customerId 时返回 400 且不返回客户', async () => {
    const response = await POST(query({ tenantId: TENANT, operation: 'crm.customer.get', params: {} }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string; data?: unknown };
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('customerId');
    expect(body.data).toBeUndefined();
  });

  it('未知 operation 返回 400', async () => {
    const response = await POST(query({ tenantId: TENANT, operation: 'crm.unknown.op', params: {} }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('unknown operation');
  });

  it('请求体不是合法 JSON 时返回 400', async () => {
    const response = await POST(request('{"tenantId":'));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('跨租户查询不返回其他租户数据', async () => {
    // c_weiye_import 属于 t_yiwu_demo；用 t_e2e_other 作用域查询必须为空。
    // 参数里伪造的 tenantId 也不能覆盖请求体声明的租户。
    const response = await POST(
      query({
        tenantId: OTHER_TENANT,
        operation: 'crm.customer.get',
        params: { customerId: CUSTOMER, tenantId: TENANT },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: null });
  });

  it('未配置服务令牌时 fail-closed 返回 503', async () => {
    const saved = process.env.TEF_CRM_SERVICE_TOKEN;
    delete process.env.TEF_CRM_SERVICE_TOKEN;
    try {
      const response = await POST(
        query({ tenantId: TENANT, operation: 'crm.customer.get', params: { customerId: CUSTOMER } }, null),
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'TEF_CRM_SERVICE_TOKEN is not configured' });
    } finally {
      process.env.TEF_CRM_SERVICE_TOKEN = saved;
    }
  });

  it('缺少 tenantId 返回 400', async () => {
    const response = await POST(query({ operation: 'crm.customer.get', params: { customerId: CUSTOMER } }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('tenantId 为空字符串返回 400', async () => {
    const response = await POST(
      query({ tenantId: '', operation: 'crm.customer.get', params: { customerId: CUSTOMER } }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  describe('effects:execute', () => {
    it('缺少 Authorization 时返回 401', async () => {
      const response = await effectsPost(
        effectsRequest(
          {
            tenantId: TENANT,
            idempotencyKey: effectsKey(),
            effects: [{ type: 'update', entity: 'product', target: PRODUCT, payload: {} }],
          },
          null,
        ),
      );
      expect(response.status).toBe(401);
    });

    it('功能开关关闭时返回 404，不触库', async () => {
      const saved = process.env.TEF_CRM_EFFECTS_ENABLED;
      delete process.env.TEF_CRM_EFFECTS_ENABLED;
      try {
        const response = await effectsPost(
          effectsRequest({
            tenantId: TENANT,
            idempotencyKey: effectsKey(),
            effects: [{ type: 'update', entity: 'product', target: PRODUCT, payload: {} }],
          }),
        );
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: 'NOT_FOUND' });
      } finally {
        if (saved === undefined) {
          delete process.env.TEF_CRM_EFFECTS_ENABLED;
        } else {
          process.env.TEF_CRM_EFFECTS_ENABLED = saved;
        }
      }
    });

    it('expectedEvidenceVersion 为空字符串返回 400', async () => {
      const response = await effectsPost(
        effectsRequest({
          tenantId: TENANT,
          idempotencyKey: effectsKey(),
          expectedEvidenceVersion: '',
          effects: [{ type: 'update', entity: 'product', target: PRODUCT, payload: {} }],
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('expectedEvidenceVersion');
    });

    it('未知 entity 返回 400', async () => {
      const response = await effectsPost(
        effectsRequest({
          tenantId: TENANT,
          idempotencyKey: effectsKey(),
          effects: [{ type: 'update', entity: 'invoice', payload: {} }],
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('entity');
    });

    it('未知 action 返回 400', async () => {
      const response = await effectsPost(
        effectsRequest({
          tenantId: TENANT,
          idempotencyKey: effectsKey(),
          effects: [{ type: 'delete', entity: 'product', payload: {} }],
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('type');
    });

    it('缺少 idempotencyKey 返回 400', async () => {
      const response = await effectsPost(
        effectsRequest({
          tenantId: TENANT,
          effects: [{ type: 'update', entity: 'product', target: PRODUCT, payload: {} }],
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['tenantId', { tenantId: OTHER_TENANT }],
      ['id', { id: 'p_hijacked' }],
    ] as const)('payload.%s 是服务端控制字段，返回 400', async (field, payload) => {
      const response = await effectsPost(
        effectsRequest({
          tenantId: TENANT,
          idempotencyKey: effectsKey(),
          effects: [{ type: 'update', entity: 'product', target: PRODUCT, payload }],
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain(`payload.${field}`);
    });

    it.each([
      [
        'increment 值非数字',
        { type: 'update', entity: 'product', target: PRODUCT, payload: {}, increment: { availableQty: '5' } },
      ],
      [
        'bind 字段类型错误',
        {
          type: 'update',
          entity: 'product',
          target: PRODUCT,
          payload: {},
          bind: { customerId: { fromRef: 'order', field: 1 } },
        },
      ],
      [
        'bind 指向 tenantId',
        {
          type: 'update',
          entity: 'product',
          target: PRODUCT,
          payload: {},
          bind: { tenantId: { fromRef: 'order', field: 'tenantId' } },
        },
      ],
      [
        'bind 指向 id',
        {
          type: 'update',
          entity: 'product',
          target: PRODUCT,
          payload: {},
          bind: { id: { fromRef: 'order', field: 'id' } },
        },
      ],
      ['空 effects 数组', null],
    ] as const)('malformed effect：%s 返回 400', async (_label, effect) => {
      const response = await effectsPost(
        effectsRequest({
          tenantId: TENANT,
          idempotencyKey: effectsKey(),
          effects: effect ? [effect] : [],
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('product.update 增量执行成功并返回 refs', async () => {
      const key = effectsKey();
      try {
        const response = await effectsPost(
          effectsRequest({
            tenantId: TENANT,
            idempotencyKey: key,
            previewId: 'pv_effects_test',
            traceId: 'tr_effects_test',
            // B2 接受但尚未比较证据版本；此处确认该字段不会破坏执行。
            expectedEvidenceVersion: 'ev_effects_test',
            effects: [
              {
                type: 'update',
                entity: 'product',
                as: 'product',
                target: PRODUCT,
                payload: {},
                increment: { availableQty: 0 },
              },
            ],
          }),
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          ok: boolean;
          refs: Record<string, Record<string, unknown>>;
        };
        expect(body.ok).toBe(true);
        expect(body.refs.product).toEqual({ id: PRODUCT, tenantId: TENANT });
      } finally {
        await resetProductFixture();
        await deleteIdempotencyRecord(key);
      }
    });

    it('同 idempotencyKey 重放返回首次响应且不重复写库存', async () => {
      const key = effectsKey();
      const body = {
        tenantId: TENANT,
        idempotencyKey: key,
        previewId: 'pv_effects_test',
        traceId: 'tr_effects_test',
        effects: [
          {
            type: 'update',
            entity: 'product',
            as: 'product',
            target: PRODUCT,
            payload: {},
            increment: { availableQty: -5, reservedQty: 5 },
          },
        ],
      };

      try {
        await resetProductFixture();

        const first = await effectsPost(effectsRequest(body));
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as { ok: boolean; refs: unknown; replayed?: boolean };
        expect(firstBody.replayed).toBeUndefined();
        await expect(readProduct()).resolves.toEqual({
          availableQty: PRODUCT_AVAILABLE_QTY - 5,
          reservedQty: 5,
        });

        const replay = await effectsPost(effectsRequest(body));
        expect(replay.status).toBe(200);
        // 重放命中幂等记录：响应与首次一致，但显式标记 replayed。
        await expect(replay.json()).resolves.toEqual({ ...firstBody, replayed: true });

        // 重放命中幂等记录，不再执行 effects，库存保持首次执行后的值。
        await expect(readProduct()).resolves.toEqual({
          availableQty: PRODUCT_AVAILABLE_QTY - 5,
          reservedQty: 5,
        });
      } finally {
        await resetProductFixture();
        await deleteIdempotencyRecord(key);
      }
    });

    it('并发同 idempotencyKey 只执行一次，另一个按重放返回', async () => {
      const key = effectsKey();
      const body = {
        tenantId: TENANT,
        idempotencyKey: key,
        previewId: 'pv_effects_test',
        traceId: 'tr_effects_test',
        effects: [
          {
            type: 'update',
            entity: 'product',
            as: 'product',
            target: PRODUCT,
            payload: {},
            increment: { availableQty: -7, reservedQty: 7 },
          },
        ],
      };

      try {
        await resetProductFixture();

        // 两个请求同时进入：都读不到幂等记录，先提交者成功；后提交者在唯一
        // 索引上得到 P2002，整个事务回滚，再由路由读取先提交者的记录重放。
        const [first, second] = await Promise.all([
          effectsPost(effectsRequest(body)),
          effectsPost(effectsRequest(body)),
        ]);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const bodies = (await Promise.all([first.json(), second.json()])) as Array<{
          ok: boolean;
          refs: Record<string, Record<string, unknown>>;
          replayed?: boolean;
        }>;
        expect(bodies.filter((entry) => entry.ok)).toHaveLength(2);
        expect(bodies.filter((entry) => entry.replayed === true)).toHaveLength(1);
        expect(bodies.filter((entry) => entry.replayed !== true)).toHaveLength(1);

        // 失败方的事务回滚了它自己的库存扣减，净效果只应用一次。
        await expect(readProduct()).resolves.toEqual({
          availableQty: PRODUCT_AVAILABLE_QTY - 7,
          reservedQty: 7,
        });
      } finally {
        await resetProductFixture();
        await deleteIdempotencyRecord(key);
      }
    });

    it('目标不存在时返回结构化 CONFLICT', async () => {
      const key = effectsKey();
      try {
        const response = await effectsPost(
          effectsRequest({
            tenantId: TENANT,
            idempotencyKey: key,
            effects: [
              {
                type: 'update',
                entity: 'product',
                target: 'p_missing',
                payload: {},
                increment: { availableQty: 0 },
              },
            ],
          }),
        );
        expect(response.status).toBe(409);
        const body = (await response.json()) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe('CONFLICT');
        expect(body.error.message).toContain('p_missing');
      } finally {
        await deleteIdempotencyRecord(key);
      }
    });

    it('update 缺少 target 时返回结构化 INTERNAL', async () => {
      const response = await effectsPost(
        effectsRequest({
          tenantId: TENANT,
          idempotencyKey: effectsKey(),
          effects: [{ type: 'update', entity: 'product', payload: {} }],
        }),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INTERNAL');
    });

    it('跨租户写入同一主键返回 CONFLICT 且不修改源租户库存', async () => {
      const key = effectsKey();
      try {
        await resetProductFixture();
        const response = await effectsPost(
          effectsRequest({
            tenantId: OTHER_TENANT,
            idempotencyKey: key,
            effects: [
              {
                type: 'update',
                entity: 'product',
                target: PRODUCT,
                payload: {},
                increment: { availableQty: -1 },
              },
            ],
          }),
        );
        expect(response.status).toBe(409);
        const body = (await response.json()) as { ok: boolean; error: { code: string } };
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe('CONFLICT');
        await expect(readProduct()).resolves.toEqual({
          availableQty: PRODUCT_AVAILABLE_QTY,
          reservedQty: 0,
        });
      } finally {
        await resetProductFixture();
        await deleteIdempotencyRecord(key, OTHER_TENANT);
      }
    });
  });
});

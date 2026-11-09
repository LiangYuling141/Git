import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectsExecutionUnknownError, TefError } from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';
import { createHttpCrmGateway } from './http-gateway';
import { createCrmGateway } from './factory';
import { CRM_QUERY, type CrmBusinessGateway } from './types';

const BASE_URL = 'http://crm.internal:3000';
const SERVICE_TOKEN = 'test-service-token';
const BOUND_TENANT = 't_yiwu_demo';
const OTHER_TENANT = 't_other';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(response: Response): FetchMock {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 取出 mock fetch 的请求体；调用次数由各测试自行断言。 */
function sentBody(fetchMock: FetchMock, callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentInit(fetchMock: FetchMock, callIndex = 0): RequestInit {
  return fetchMock.mock.calls[callIndex][1] as RequestInit;
}

async function expectTefError(call: () => Promise<unknown>, code: string, message: string): Promise<void> {
  const error = await call().then(
    () => {
      throw new Error('expected the gateway to reject, but it resolved');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TefError);
  expect((error as TefError).code).toBe(code);
  expect((error as TefError).message).toBe(message);
}

function captureTefError(call: () => unknown): TefError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(TefError);
    return error as TefError;
  }
  throw new Error('expected a TefError, but no error was thrown');
}

function createGateway(baseUrl = BASE_URL): CrmBusinessGateway {
  return createHttpCrmGateway({ baseUrl, serviceToken: SERVICE_TOKEN, tenantId: BOUND_TENANT });
}

/** 任何属性访问都会抛错的事务替身：证明 HTTP 模式不触碰 Prisma 事务。 */
function untouchableTx(touched: string[]): PrismaTx {
  return new Proxy({} as PrismaTx, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`tx.${String(property)} must not be touched`);
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('请求构造', () => {
  it('query 使用 POST，携带 Bearer 令牌、租户与操作，并解包 data', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: { id: 'c_weiye_import' } }));
    const gateway = createGateway(`${BASE_URL}///`);

    const result = await gateway.query({
      tenantId: BOUND_TENANT,
      operation: CRM_QUERY.customerGet,
      params: { customerId: 'c_weiye_import' },
    });

    expect(result).toEqual({ id: 'c_weiye_import' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/internal/v1/query`);
    expect(sentInit(fetchMock).method).toBe('POST');
    expect(sentInit(fetchMock).headers).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_TOKEN}`,
    });
    expect(sentBody(fetchMock)).toEqual({
      tenantId: BOUND_TENANT,
      operation: CRM_QUERY.customerGet,
      params: { customerId: 'c_weiye_import' },
    });
  });

  it('缺少服务令牌时构造即拒绝', () => {
    const error = captureTefError(() =>
      createHttpCrmGateway({ baseUrl: BASE_URL, serviceToken: '', tenantId: BOUND_TENANT }),
    );
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('TEF_CRM_SERVICE_TOKEN is not configured');
  });

  it('缺少基址或租户绑定时构造即拒绝', () => {
    const missingBaseUrl = captureTefError(() =>
      createHttpCrmGateway({ baseUrl: '', serviceToken: SERVICE_TOKEN, tenantId: BOUND_TENANT }),
    );
    expect(missingBaseUrl.code).toBe('INTERNAL');
    expect(missingBaseUrl.message).toBe('TEF_CRM_API_BASE is not configured');

    const missingTenant = captureTefError(() =>
      createHttpCrmGateway({ baseUrl: BASE_URL, serviceToken: SERVICE_TOKEN, tenantId: '' }),
    );
    expect(missingTenant.code).toBe('INTERNAL');
    expect(missingTenant.message).toBe('HttpCrmGateway tenantId is not configured');
  });

  it('请求携带 10 秒超时信号', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: null }));
    const gateway = createGateway();

    await gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_1' });

    expect(sentInit(fetchMock).signal).toBeInstanceOf(AbortSignal);
  });
});

describe('参数清理：缺省字段用空字符串表示时不得发给内部网关', () => {
  it('searchCustomers 去掉空字符串 phone，保留 name 与 limit', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [] }));
    const gateway = createGateway();

    await gateway.searchCustomers({ tenantId: BOUND_TENANT, name: '伟业', phone: '', limit: 10 });

    expect(sentBody(fetchMock)).toEqual({
      tenantId: BOUND_TENANT,
      operation: CRM_QUERY.customerSearch,
      params: { tenantId: BOUND_TENANT, name: '伟业', limit: 10 },
    });
  });

  it('getOrder 去掉空字符串 orderId，保留 orderNo', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: null }));
    const gateway = createGateway();

    await gateway.getOrder({ tenantId: BOUND_TENANT, orderId: '', orderNo: 'SO-X' });

    expect(sentBody(fetchMock)).toEqual({
      tenantId: BOUND_TENANT,
      operation: CRM_QUERY.orderGet,
      params: { tenantId: BOUND_TENANT, orderNo: 'SO-X' },
    });
  });

  it('只清理 undefined 与空字符串，不误删 0、false 与空数组', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: [] }));
    const gateway = createGateway();

    await gateway.query({
      tenantId: BOUND_TENANT,
      operation: CRM_QUERY.customerSearch,
      params: { name: '伟业', phone: undefined, limit: 0, exact: false, skus: [] },
    });

    expect(sentBody(fetchMock).params).toEqual({ name: '伟业', limit: 0, exact: false, skus: [] });
  });
});

describe('租户绑定：调用方 tenantId 必须与工厂闭包一致', () => {
  it('全部读方法在 tenantId 不匹配时抛 PERMISSION_DENIED，且不发请求', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: null }));
    const gateway = createGateway();

    const calls: Array<[keyof CrmBusinessGateway, () => Promise<unknown>]> = [
      ['searchCustomers', () => gateway.searchCustomers({ tenantId: OTHER_TENANT, name: '伟业' })],
      ['getCustomer', () => gateway.getCustomer({ tenantId: OTHER_TENANT, customerId: 'c_1' })],
      ['getCredit', () => gateway.getCredit({ tenantId: OTHER_TENANT, customerId: 'c_1' })],
      ['getProducts', () => gateway.getProducts({ tenantId: OTHER_TENANT, skus: ['SKU-1'] })],
      ['searchProducts', () => gateway.searchProducts({ tenantId: OTHER_TENANT, term: '圣诞' })],
      ['getOrder', () => gateway.getOrder({ tenantId: OTHER_TENANT, orderId: 'ord_1' })],
      [
        'query',
        () =>
          gateway.query({
            tenantId: OTHER_TENANT,
            operation: CRM_QUERY.customerGet,
            params: { customerId: 'c_1' },
          }),
      ],
    ];

    for (const [method, call] of calls) {
      await expectTefError(call, 'PERMISSION_DENIED', 'gateway tenant mismatch');
      expect(fetchMock, `${method} must reject before sending any request`).not.toHaveBeenCalled();
    }
  });
});

describe('错误映射', () => {
  it('非 2xx 响应抛 TefError(INTERNAL)，优先使用服务端 message', async () => {
    stubFetch(jsonResponse({ error: 'INTERNAL', message: 'internal gateway error' }, 500));
    const gateway = createGateway();

    await expectTefError(
      () => gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_1' }),
      'INTERNAL',
      'internal gateway error',
    );
  });

  it('非 2xx 且响应体不是 JSON 时使用状态码兜底文案', async () => {
    stubFetch(new Response('bad gateway', { status: 502 }));
    const gateway = createGateway();

    await expectTefError(
      () => gateway.searchProducts({ tenantId: BOUND_TENANT, term: '圣诞' }),
      'INTERNAL',
      'CRM gateway error 502',
    );
  });

  it('成功响应缺少 message 时不误判：2xx 直接返回 data', async () => {
    stubFetch(jsonResponse({ data: [] }));
    const gateway = createGateway();

    await expect(gateway.searchCustomers({ tenantId: BOUND_TENANT, phone: '13905791001' })).resolves.toEqual([]);
  });

  it.each([
    ['VALIDATION_ERROR', 400],
    ['PERMISSION_DENIED', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
  ] as const)('非 2xx 的 %s 映射为同名 TefError 错误码', async (code, status) => {
    stubFetch(jsonResponse({ error: code, message: `${code} from crm` }, status));
    const gateway = createGateway();

    await expectTefError(
      () => gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_1' }),
      code,
      `${code} from crm`,
    );
  });

  it('未映射的错误码回落到 INTERNAL，但仍使用服务端 message', async () => {
    stubFetch(jsonResponse({ error: 'TEAPOT', message: 'unexpected gateway state' }, 418));
    const gateway = createGateway();

    await expectTefError(
      () => gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_1' }),
      'INTERNAL',
      'unexpected gateway state',
    );
  });

  it('网络失败包装为 TefError(INTERNAL)，不泄漏原生 TypeError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = createGateway();

    await expectTefError(
      () => gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_1' }),
      'INTERNAL',
      'CRM gateway request failed: fetch failed',
    );
  });
});

describe('类型化方法映射', () => {
  it('六个类型化读方法映射到 CRM_QUERY 白名单 operation', async () => {
    const cases = [
      {
        operation: CRM_QUERY.customerSearch,
        input: { tenantId: BOUND_TENANT, name: '伟业', limit: 5 },
        data: [{ id: 'c_weiye_import' }],
        call: (gateway: CrmBusinessGateway) =>
          gateway.searchCustomers({ tenantId: BOUND_TENANT, name: '伟业', limit: 5 }),
      },
      {
        operation: CRM_QUERY.customerGet,
        input: { tenantId: BOUND_TENANT, customerId: 'c_weiye_import' },
        data: { id: 'c_weiye_import' },
        call: (gateway: CrmBusinessGateway) =>
          gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_weiye_import' }),
      },
      {
        operation: CRM_QUERY.creditGet,
        input: { tenantId: BOUND_TENANT, customerId: 'c_weiye_import' },
        data: { customer: { id: 'c_weiye_import' }, openOrders: [] },
        call: (gateway: CrmBusinessGateway) =>
          gateway.getCredit({ tenantId: BOUND_TENANT, customerId: 'c_weiye_import' }),
      },
      {
        operation: CRM_QUERY.productsGet,
        input: { tenantId: BOUND_TENANT, skus: ['XMAS-BALL-01'] },
        data: [{ sku: 'XMAS-BALL-01' }],
        call: (gateway: CrmBusinessGateway) =>
          gateway.getProducts({ tenantId: BOUND_TENANT, skus: ['XMAS-BALL-01'] }),
      },
      {
        operation: CRM_QUERY.productsSearch,
        input: { tenantId: BOUND_TENANT, term: '圣诞球' },
        data: [{ sku: 'XMAS-BALL-01' }],
        call: (gateway: CrmBusinessGateway) =>
          gateway.searchProducts({ tenantId: BOUND_TENANT, term: '圣诞球' }),
      },
      {
        operation: CRM_QUERY.orderGet,
        input: { tenantId: BOUND_TENANT, orderNo: 'SO-1' },
        data: null,
        call: (gateway: CrmBusinessGateway) =>
          gateway.getOrder({ tenantId: BOUND_TENANT, orderNo: 'SO-1' }),
      },
    ];

    for (const entry of cases) {
      const fetchMock = stubFetch(jsonResponse({ data: entry.data }));
      const gateway = createGateway();

      await expect(entry.call(gateway)).resolves.toEqual(entry.data);
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/internal/v1/query`);
      expect(sentBody(fetchMock)).toEqual({
        tenantId: BOUND_TENANT,
        operation: entry.operation,
        params: entry.input,
      });
    }
  });

});

describe('effects:execute', () => {
  function effectsInput(tenantId = BOUND_TENANT) {
    return {
      tenantId,
      idempotencyKey: 'idem_effects_1',
      previewId: 'pv_effects_1',
      traceId: 'tr_effects_1',
      expectedEvidenceVersion: 'ev_effects_1',
      effects: [
        {
          type: 'update' as const,
          entity: 'product',
          target: 'p_xmas_ball',
          payload: {},
          increment: { availableQty: -5, reservedQty: 5 },
        },
      ],
    };
  }

  it('调用 /api/internal/v1/effects/execute，原样返回 refs 与重放标记', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ ok: true, refs: { product: { id: 'p_xmas_ball' } }, replayed: true }),
    );
    const gateway = createGateway();
    const input = effectsInput();

    const result = await gateway.executeEffects(input);

    expect(result).toEqual({
      ok: true,
      refs: { product: { id: 'p_xmas_ball' } },
      replayed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/internal/v1/effects/execute`);
    expect(sentInit(fetchMock).method).toBe('POST');
    expect(sentInit(fetchMock).headers).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_TOKEN}`,
    });
    expect(sentBody(fetchMock)).toEqual(input);
  });

  it('409 CONFLICT 映射为 ok:false，不抛异常', async () => {
    stubFetch(
      jsonResponse(
        { ok: false, error: { code: 'CONFLICT', message: 'target "p_missing" not found' } },
        409,
      ),
    );
    const gateway = createGateway();

    await expect(gateway.executeEffects(effectsInput())).resolves.toEqual({
      ok: false,
      refs: {},
      error: { code: 'CONFLICT', message: 'target "p_missing" not found' },
    });
  });

  it('400 校验失败是确定性错误：ok:false INTERNAL，不升级为 unknown', async () => {
    stubFetch(
      jsonResponse(
        { ok: false, error: { code: 'VALIDATION_ERROR', message: 'payload.id is not allowed' } },
        400,
      ),
    );
    const gateway = createGateway();

    await expect(gateway.executeEffects(effectsInput())).resolves.toEqual({
      ok: false,
      refs: {},
      error: { code: 'INTERNAL', message: 'payload.id is not allowed' },
    });
  });

  it.each([500, 502, 504] as const)(
    '%s 无法证明副作用未提交：抛 EffectsExecutionUnknownError 交给对账',
    async (status) => {
      stubFetch(jsonResponse({ ok: false, error: { code: 'INTERNAL', message: 'upstream failed' } }, status));
      const gateway = createGateway();

      await expect(gateway.executeEffects(effectsInput())).rejects.toBeInstanceOf(
        EffectsExecutionUnknownError,
      );
    },
  );

  it('网络错误/超时抛 EffectsExecutionUnknownError，而不是可能诱导换 key 的 INTERNAL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );
    const gateway = createGateway();

    await expect(gateway.executeEffects(effectsInput())).rejects.toBeInstanceOf(
      EffectsExecutionUnknownError,
    );
  });

  it('503 EXECUTION_UNKNOWN 抛 EffectsExecutionUnknownError，交给状态机收敛为 unknown', async () => {
    stubFetch(
      jsonResponse(
        { ok: false, error: { code: 'EXECUTION_UNKNOWN', message: 'commit outcome is unknown' } },
        503,
      ),
    );
    const gateway = createGateway();

    const error = await gateway.executeEffects(effectsInput()).then(
      () => {
        throw new Error('expected executeEffects to reject with the unknown outcome');
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(EffectsExecutionUnknownError);
    expect((error as Error).message).toBe('commit outcome is unknown');
  });

  it('503 非法结构化响应同样按 unknown 处理，而不是 INTERNAL', async () => {
    stubFetch(new Response('upstream unavailable', { status: 503 }));
    const gateway = createGateway();

    await expect(gateway.executeEffects(effectsInput())).rejects.toBeInstanceOf(
      EffectsExecutionUnknownError,
    );
  });

  it('租户不一致时抛 PERMISSION_DENIED，且不发请求', async () => {
    const fetchMock = stubFetch(jsonResponse({ ok: true, refs: {} }));
    const gateway = createGateway();

    await expectTefError(
      () => gateway.executeEffects(effectsInput(OTHER_TENANT)),
      'PERMISSION_DENIED',
      'gateway tenant mismatch',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2xx 响应结构非法时抛 INTERNAL，ok:false 时保留错误详情', async () => {
    stubFetch(jsonResponse({ ok: true }));
    const invalidGateway = createGateway();

    await expectTefError(
      () => invalidGateway.executeEffects(effectsInput()),
      'INTERNAL',
      'invalid effects response',
    );

    stubFetch(
      jsonResponse({ ok: false, refs: {}, error: { code: 'CONFLICT', message: 'stock changed' } }),
    );
    const failedGateway = createGateway();

    await expect(failedGateway.executeEffects(effectsInput())).resolves.toEqual({
      ok: false,
      refs: {},
      error: { code: 'CONFLICT', message: 'stock changed' },
    });
  });
});

describe('工厂切换：TEF_CRM_GATEWAY', () => {
  it('未设置或 prisma 时返回进程内 Prisma 网关', async () => {
    for (const mode of ['', 'prisma']) {
      vi.stubEnv('TEF_CRM_GATEWAY', mode);
      const touched: string[] = [];
      const gateway = createCrmGateway(untouchableTx(touched), BOUND_TENANT);

      await expectTefError(
        () =>
          gateway.executeEffects({
            tenantId: BOUND_TENANT,
            idempotencyKey: 'idem_1',
            previewId: 'prev_1',
            traceId: 'tr_1',
            effects: [],
          }),
        'INTERNAL',
        'PrismaCrmGateway.executeEffects is implemented in Phase B2/C',
      );
      expect(touched, `${mode || '(unset)'} must select the Prisma gateway`).toEqual([]);
    }
  });

  it('http 时返回 HTTP 网关，使用 TEF_CRM_API_BASE 与 TEF_CRM_SERVICE_TOKEN，且不触碰事务', async () => {
    vi.stubEnv('TEF_CRM_GATEWAY', 'http');
    vi.stubEnv('TEF_CRM_API_BASE', 'http://crm.example:4000');
    vi.stubEnv('TEF_CRM_SERVICE_TOKEN', SERVICE_TOKEN);
    const fetchMock = stubFetch(jsonResponse({ data: null }));
    const touched: string[] = [];
    const gateway = createCrmGateway(untouchableTx(touched), BOUND_TENANT);

    await expect(gateway.getCustomer({ tenantId: BOUND_TENANT, customerId: 'c_1' })).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('http://crm.example:4000/api/internal/v1/query');
    expect(sentInit(fetchMock).headers).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_TOKEN}`,
    });
    expect(touched).toEqual([]);
  });

  it('http 模式缺少基址或服务令牌时 fail-closed，不降级到 Prisma', () => {
    vi.stubEnv('TEF_CRM_GATEWAY', 'http');

    vi.stubEnv('TEF_CRM_API_BASE', '');
    vi.stubEnv('TEF_CRM_SERVICE_TOKEN', SERVICE_TOKEN);
    expect(() => createCrmGateway({} as PrismaTx, BOUND_TENANT)).toThrow(
      'TEF_CRM_API_BASE is not configured',
    );

    vi.stubEnv('TEF_CRM_API_BASE', BASE_URL);
    vi.stubEnv('TEF_CRM_SERVICE_TOKEN', '');
    expect(() => createCrmGateway({} as PrismaTx, BOUND_TENANT)).toThrow(
      'TEF_CRM_SERVICE_TOKEN is not configured',
    );
  });

  it('未知非空模式直接报错，不静默回落到 Prisma', () => {
    vi.stubEnv('TEF_CRM_GATEWAY', 'htp');
    expect(() => createCrmGateway({} as PrismaTx, BOUND_TENANT)).toThrow(
      'unknown TEF_CRM_GATEWAY: htp',
    );
  });
});

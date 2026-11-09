import { afterEach, describe, expect, it, vi } from 'vitest';
import { TefError } from '@lymtrix/tef-core';
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

  it('executeEffects 在 Task 3 实现前显式拒绝，不发请求', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: null }));
    const gateway = createGateway();

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
      'HttpCrmGateway.executeEffects is implemented in Task 3',
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
});

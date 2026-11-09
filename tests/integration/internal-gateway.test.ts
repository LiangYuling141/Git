import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/internal/v1/query/route';

/**
 * 内部 query 网关集成测试。
 *
 * 需要真实 PostgreSQL：`TEF_DB_TESTS=1 npx vitest run tests/integration/internal-gateway.test.ts`。
 * 本任务只读种子数据，不写业务数据，因此不需要复位夹具。
 */

const RUN_DB = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDb = RUN_DB ? describe : describe.skip;

const TENANT = 't_yiwu_demo';
const OTHER_TENANT = 't_e2e_other';
const CUSTOMER = 'c_weiye_import';
const TOKEN = 'test-internal-token';

let savedToken: string | undefined;

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

describeDb('内部 query 网关（真实数据库）', () => {
  beforeAll(() => {
    savedToken = process.env.TEF_CRM_SERVICE_TOKEN;
    process.env.TEF_CRM_SERVICE_TOKEN = TOKEN;
  });

  afterAll(() => {
    if (savedToken === undefined) {
      delete process.env.TEF_CRM_SERVICE_TOKEN;
    } else {
      process.env.TEF_CRM_SERVICE_TOKEN = savedToken;
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
});

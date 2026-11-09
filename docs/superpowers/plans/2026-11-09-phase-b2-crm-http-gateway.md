# Phase B2：CRM 通用 HTTP 网关与 HttpCrmGateway 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 CRM 应用中实现内部 HTTP 网关（query / effects:execute），并在垂直包实现 `HttpCrmGateway`，使业务 MCP 可以在不直连业务库的情况下读取证据与执行副作用；默认仍使用进程内 Prisma 网关，HTTP 模式通过环境变量启用。

**Architecture:** CRM 应用持有业务库与 effects 适配器，暴露仅内网可达的 `/api/internal/v1/*`，用服务令牌与 tenantId 鉴权；垂直包新增 `createHttpCrmGateway`，通过 `TEF_CRM_GATEWAY=http` 切换。`BusinessGateway` 核心端口保持泛型不变。副作用执行仍由调用方事务控制；B2 只提供网关入口与幂等，不改变 TEF 的 execute 状态机（Phase C）。

**Tech Stack:** Next.js Route Handlers、Prisma 7、zod、Vitest 3、npm workspaces。

## Global Constraints

- 不改变默认运行时行为；默认 `TEF_CRM_GATEWAY=prisma`，309 项测试必须继续通过。
- 内部网关只接受服务令牌；缺失配置时 fail-closed。
- 所有 query/effects 必须带 tenantId，并拒绝未知操作/实体/动作。
- effects 幂等记录与业务写入在同一个 Prisma 事务内提交。
- 不修改全局 TypeScript 选项；旧路径与 shim 保持可用。
- 用户已授权本地提交（仅本地，不推送）。
- 本计划只覆盖 B2；B3（独立存储/TEF Server/Docker）另行成计划。

---

## Task 1：CRM 内部 query API

**Files:**
- Create: `src/app/api/internal/v1/query/route.ts`
- Create: `src/lib/internal-auth.ts`
- Create: `tests/integration/internal-gateway.test.ts`
- Modify: `.env.example`
- Modify: `vitest.config.ts`（仅在需要时设置测试环境变量）

**Interfaces:**
- `POST /api/internal/v1/query`：`{ tenantId, operation, params }` → `{ data }`
- `authorizeInternalRequest(request): string | null`（错误消息或 null）

- [ ] **Step 1：服务令牌鉴权**

创建 `src/lib/internal-auth.ts`：

```ts
export function authorizeInternalRequest(request: Request): string | null {
  const expected = process.env.TEF_CRM_SERVICE_TOKEN;
  if (!expected) return 'TEF_CRM_SERVICE_TOKEN is not configured';
  const header = request.headers.get('authorization') ?? '';
  if (header !== `Bearer ${expected}`) return 'unauthorized';
  return null;
}

export function internalAuthStatus(message: string): number {
  return message === 'unauthorized' ? 401 : 503;
}
```

- [ ] **Step 2：query 路由**

创建 `src/app/api/internal/v1/query/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenantScope } from '@/tef/tenant-scope';
import { createPrismaCrmGateway } from '@lymtrix/vertical-crm-erp';
import { authorizeInternalRequest, internalAuthStatus } from '@/lib/internal-auth';

const bodySchema = z.object({
  tenantId: z.string().min(1),
  operation: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: Request) {
  const authError = authorizeInternalRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError }, { status: internalAuthStatus(authError) });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', message: parsed.error.message }, { status: 400 });
  }

  const { tenantId, operation, params } = parsed.data;
  try {
    const data = await withTenantScope(tenantId, (tx) => {
      const gateway = createPrismaCrmGateway(tx, tenantId);
      return gateway.query({ tenantId, operation, params });
    });
    return NextResponse.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'query failed';
    return NextResponse.json({ error: 'QUERY_FAILED', message }, { status: 400 });
  }
}
```

- [ ] **Step 3：测试**

在 `tests/integration/internal-gateway.test.ts` 中：

- 设置 `process.env.TEF_CRM_SERVICE_TOKEN = 'test-internal-token'`。
- 无 Authorization → 401。
- `customer.get` 使用种子客户 → 200，返回 `data.id`。
- 未知 operation → 400。
- 跨租户 token/tenant 组合不会返回其他租户数据（用 `t_e2e_other` 客户 id 查 `t_yiwu_demo`）。

- [ ] **Step 4：验证**

```bash
TEF_DB_TESTS=1 npx vitest run tests/integration/internal-gateway.test.ts
npm run typecheck
npm run lint
```

---

## Task 2：HttpCrmGateway query 与垂直切换

**Files:**
- Create: `verticals/crm-erp-mcp/src/gateway/http-gateway.ts`
- Create: `verticals/crm-erp-mcp/src/gateway/factory.ts`
- Modify: `verticals/crm-erp-mcp/src/tools/query.ts`
- Modify: `verticals/crm-erp-mcp/src/tools/order.ts`
- Create: `verticals/crm-erp-mcp/src/gateway/http-gateway.test.ts`
- Modify: `verticals/crm-erp-mcp/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- `createHttpCrmGateway({ baseUrl, serviceToken, tenantId }): CrmBusinessGateway`
- `createCrmGateway(tx, tenantId): CrmBusinessGateway`（按 `TEF_CRM_GATEWAY` 选择）

- [ ] **Step 1：实现 HttpCrmGateway**

创建 `verticals/crm-erp-mcp/src/gateway/http-gateway.ts`：

```ts
import { TefError } from '@lymtrix/tef-core';
import type {
  CrmBusinessGateway,
  CustomerRecord,
  CreditRecord,
  OrderRecord,
  ProductRecord,
} from './types';
import { CRM_QUERY } from './types';

export interface HttpCrmGatewayOptions {
  baseUrl: string;
  serviceToken: string;
  tenantId: string;
}

export function createHttpCrmGateway(options: HttpCrmGatewayOptions): CrmBusinessGateway {
  const { baseUrl, serviceToken, tenantId } = options;
  if (!serviceToken) throw new TefError('INTERNAL', 'TEF_CRM_SERVICE_TOKEN is not configured');

  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new TefError('INTERNAL', payload.message ?? `CRM gateway error ${response.status}`);
    }
    return payload as T;
  };

  const assertTenant = (inputTenant: string): void => {
    if (inputTenant !== tenantId) throw new TefError('PERMISSION_DENIED', 'gateway tenant mismatch');
  };

  const gateway = {
    async query<T>(input: { tenantId: string; operation: string; params: Record<string, unknown> }): Promise<T> {
      assertTenant(input.tenantId);
      const result = await call<{ data: T }>('/api/internal/v1/query', {
        tenantId: input.tenantId,
        operation: input.operation,
        params: input.params,
      });
      return result.data;
    },
    searchCustomers(input: { tenantId: string; name?: string; phone?: string; limit?: number }) {
      return gateway.query<CustomerRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.customerSearch, params: input });
    },
    getCustomer(input: { tenantId: string; customerId: string }) {
      return gateway.query<CustomerRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.customerGet, params: input });
    },
    getCredit(input: { tenantId: string; customerId: string }) {
      return gateway.query<CreditRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.creditGet, params: input });
    },
    getProducts(input: { tenantId: string; skus: string[] }) {
      return gateway.query<ProductRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.productsGet, params: input });
    },
    searchProducts(input: { tenantId: string; term?: string }) {
      return gateway.query<ProductRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.productsSearch, params: input });
    },
    getOrder(input: { tenantId: string; orderId?: string; orderNo?: string }) {
      return gateway.query<OrderRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.orderGet, params: input });
    },
    async executeEffects(): Promise<never> {
      throw new TefError('INTERNAL', 'HttpCrmGateway.executeEffects is implemented in Task 3');
    },
  } as CrmBusinessGateway;

  return gateway;
}
```

- [ ] **Step 2：网关工厂**

创建 `verticals/crm-erp-mcp/src/gateway/factory.ts`：

```ts
import type { BusinessGateway } from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';
import { createPrismaCrmGateway } from './prisma-gateway';
import { createHttpCrmGateway } from './http-gateway';
import type { CrmBusinessGateway } from './types';

export function createCrmGateway(tx: PrismaTx, tenantId: string): CrmBusinessGateway {
  if (process.env.TEF_CRM_GATEWAY === 'http') {
    const baseUrl = process.env.TEF_CRM_API_BASE;
    const serviceToken = process.env.TEF_CRM_SERVICE_TOKEN;
    if (!baseUrl) throw new Error('TEF_CRM_API_BASE is not configured');
    if (!serviceToken) throw new Error('TEF_CRM_SERVICE_TOKEN is not configured');
    return createHttpCrmGateway({ baseUrl, serviceToken, tenantId });
  }
  return createPrismaCrmGateway(tx, tenantId);
}

export type { BusinessGateway };
```

- [ ] **Step 3：切换默认工厂**

在 `tools/query.ts` 与 `tools/order.ts` 中，把 `createPrismaCrmGateway` 的默认注入替换为 `createCrmGateway`；显式传入的 `gateway`/`gatewayFactory` 优先。导出 `createCrmGateway` / `createHttpCrmGateway` 到垂直 index。

- [ ] **Step 4：测试**

`http-gateway.test.ts` 用 mock fetch：

- query 构造正确的 URL/Authorization/body。
- 非 2xx 抛 `TefError`。
- 租户不一致抛 `PERMISSION_DENIED` 且不 fetch。
- 6 个类型化方法映射到正确的 operation。

- [ ] **Step 5：验证**

```bash
npx vitest run verticals/crm-erp-mcp tests/integration/internal-gateway.test.ts
npm run boundaries:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
```

---

## Task 3：CRM effects:execute 与幂等

**Files:**
- Create: `src/app/api/internal/v1/effects/execute/route.ts`
- Modify: `tests/integration/internal-gateway.test.ts`
- Modify: `.env.example`

**Interfaces:**
- `POST /api/internal/v1/effects/execute`：`{ tenantId, idempotencyKey, previewId, traceId, expectedEvidenceVersion?, effects }` → `{ ok, refs }` / `{ ok:false, error }`

- [ ] **Step 1：effect 白名单 schema**

用 zod 校验 effects：

```ts
const effectSchema = z.object({
  type: z.enum(['create', 'update', 'reserve', 'release']),
  entity: z.enum(['order', 'payment', 'product', 'customer']),
  as: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
  target: z.string().optional(),
  increment: z.record(z.string(), z.number()).optional(),
  bind: z.record(z.string(), z.object({ fromRef: z.string(), field: z.string() })).optional(),
});
```

- [ ] **Step 2：路由实现**

在 `src/app/api/internal/v1/effects/execute/route.ts`：

- 服务令牌鉴权。
- 解析 body；`tenantId`、`idempotencyKey` 必填。
- `withTenantScope(tenantId, async (tx) => { ... })`：
  - 查幂等记录 `idempotencyRecord`（`toolName: 'internal.effects.execute'`）；存在则返回 `response`。
  - `const adapters = createCreditOrderAdapters(tx, tenantId, { previewId, traceId });`
  - `const result = await executeEffects(effects, adapters);`
  - 写幂等记录 `{ response: { ok: true, refs: result.refs } }`。
- 捕获 `EffectExecutionError`：`CONFLICT` → 409，`INTERNAL` → 500；事务回滚。
- 返回结构化 JSON。

- [ ] **Step 3：测试**

在 `internal-gateway.test.ts` 增加：

- 未授权 → 401。
- 未知 entity/action → 400。
- `product.update` 增量执行成功，响应含 refs；同 idempotencyKey 重放返回同一响应且库存不再变化。
- 冲突/失败返回结构化错误。

- [ ] **Step 4：验证**

```bash
TEF_DB_TESTS=1 npx vitest run tests/integration/internal-gateway.test.ts
npm run typecheck
npm run lint
```

---

## Task 4：HttpCrmGateway effects、文档与最终验收

**Files:**
- Modify: `verticals/crm-erp-mcp/src/gateway/http-gateway.ts`
- Modify: `verticals/crm-erp-mcp/src/gateway/http-gateway.test.ts`
- Modify: `README.md`
- Modify: `docs/00-framework.md`
- Modify: `docs/superpowers/specs/2026-11-09-tef-extraction-design.md`
- Modify: `docs/superpowers/plans/2026-11-09-phase-b2-crm-http-gateway.md`
- Modify: `.env.example`

- [ ] **Step 1：实现 executeEffects**

`HttpCrmGateway.executeEffects` 调 `/api/internal/v1/effects/execute`，返回 `EffectsExecuteResult`；非 2xx 映射为 `ok:false` + error code。

- [ ] **Step 2：测试**

增加 HTTP effects 测试（mock fetch）：成功、冲突、租户不一致。

- [ ] **Step 3：文档**

- `.env.example` 增加 `TEF_CRM_GATEWAY`、`TEF_CRM_API_BASE`、`TEF_CRM_SERVICE_TOKEN`。
- README 与 00-framework 记录内部网关端点、鉴权与默认 prisma 模式。
- 设计 spec 更新 B2 状态与测试基线（新增测试后同步）。
- B2 计划状态标记完成。

- [ ] **Step 4：最终验收**

```bash
npm run boundaries:check
npm run secrets:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
npm run build
```

Expected: 全部通过；新增测试后基线按实际数量同步到文档。

---

## 后续计划索引

| 计划 | 内容 | 前置 |
|------|------|------|
| Phase B3 | TefStateStore/Clock、独立 schema、Tef Server、Docker Compose | B2 完成 |
| Phase C | P1 收尾：执行状态机、故障注入、并发与崩溃恢复 | B3 完成 |
| Phase D | P2 准备：指标埋点、fixture、eval harness 与种子样本 | C 完成 |

## 自检记录

- 规格覆盖：对应设计文档 §5.3 的 query / effects:execute 与 §8.2 B2；evidence 由垂直从 query 结果组合，不单独开端点。
- 占位符：无 TBD/TODO；关键文件给出完整代码。
- 安全：服务令牌、tenantId 校验、effect 白名单、幂等记录与业务写入同事务。

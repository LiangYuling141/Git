# Phase B1.5：BusinessGateway 端口垂直中立化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `tef-core` 的 `BusinessGateway` 改为垂直中立的泛型端口（`query(operation, params)` + `executeEffects`），把 CRM 客户/商品/订单 DTO 下沉到垂直包；现有查询工具与契约通过 CRM 类型适配器继续工作，行为与 308 项测试不变（新增 1 个 query 分发测试后为 309）。

**Architecture:** 核心只认识“查询名 + 参数 + 结果”，不认识 creditLimit/depositRate 等 CRM 字段。垂直包定义 `CrmBusinessGateway extends BusinessGateway`，保留现有类型化读取方法；`PrismaCrmGateway` 同时实现类型化方法与泛型 `query` 分发。契约通过 `requireCrmGateway(ctx)` 在垂直边界内取回类型化网关。

**Tech Stack:** TypeScript 5.7、Prisma 7、Vitest 3、npm workspaces。

## Global Constraints

- 不改变查询工具与契约的可观察行为；308 个既有测试必须全部通过。
- `tef-core` 不得出现 CRM 业务字段；所有 CRM DTO 移到垂直包。
- `tef-mcp-kit` 仍不依赖垂直包；`ContractWriteOptions.gatewayFactory` 返回核心泛型 `BusinessGateway`。
- 旧导入路径与 shim 保持不变。
- 用户已授权本地提交（仅本地，不推送）。
- 本计划只覆盖端口中立化；B2 HTTP 网关另行成计划。

---

## Task 1：核心端口泛型化与 DTO 下沉

**Files:**
- Modify: `packages/tef-core/src/business-gateway.ts`
- Create: `verticals/crm-erp-mcp/src/gateway/types.ts`
- Create: `verticals/crm-erp-mcp/src/gateway/context.ts`
- Modify: `verticals/crm-erp-mcp/src/gateway/prisma-gateway.ts`
- Modify: `verticals/crm-erp-mcp/src/tools/query.ts`
- Modify: `verticals/crm-erp-mcp/src/contracts/credit-order/create-order.ts`
- Modify: `verticals/crm-erp-mcp/src/contracts/credit-order/compensate-order.ts`
- Modify: `verticals/crm-erp-mcp/src/index.ts`
- Modify: `packages/tef-mcp-kit/src/tools/contract.ts`

**Interfaces:**
- Core `BusinessGateway`:
  - `query<T = unknown>(input: { tenantId: string; operation: string; params: Record<string, unknown> }): Promise<T>`
  - `executeEffects(input: EffectsExecuteRequest): Promise<EffectsExecuteResult>`
- Vertical `CrmBusinessGateway extends BusinessGateway` with the existing typed read methods.
- `CRM_QUERY` operation constants.

- [ ] **Step 1：重写核心端口**

`packages/tef-core/src/business-gateway.ts` 只保留：

```ts
import type { Effect } from './types';

export interface BusinessQueryRequest {
  tenantId: string;
  /** 例如 crm.customer.search；由垂直包声明白名单。 */
  operation: string;
  params: Record<string, unknown>;
}

export interface EffectsExecuteRequest {
  tenantId: string;
  idempotencyKey: string;
  previewId: string;
  traceId: string;
  /** 由 B2 定义来源与冲突语义；B1.5 不使用。 */
  expectedEvidenceVersion?: string;
  effects: Effect[];
}

export interface EffectsExecuteResult {
  ok: boolean;
  refs: Record<string, Record<string, unknown>>;
  error?: { code: 'CONFLICT' | 'INTERNAL'; message: string };
}

/**
 * 业务数据访问端口。核心只认识“查询名 + 参数 + 结果”，不认识任何垂直 DTO。
 */
export interface BusinessGateway {
  query<T = unknown>(input: BusinessQueryRequest): Promise<T>;
  executeEffects(input: EffectsExecuteRequest): Promise<EffectsExecuteResult>;
}
```

- [ ] **Step 2：DTO 下沉到垂直包**

把原 `business-gateway.ts` 中的 `CustomerRecord`、`ProductRecord`、`PaymentRecord`、`OrderRecord`、`CreditRecord`、`CustomerSearchInput` 原样移到 `verticals/crm-erp-mcp/src/gateway/types.ts`，并增加：

```ts
import type { BusinessGateway } from '@lymtrix/tef-core';
import type {
  CreditRecord,
  CustomerRecord,
  CustomerSearchInput,
  OrderRecord,
  ProductRecord,
} from './types';

export const CRM_QUERY = {
  customerSearch: 'crm.customer.search',
  customerGet: 'crm.customer.get',
  creditGet: 'crm.credit.get',
  productsGet: 'crm.products.get',
  productsSearch: 'crm.products.search',
  orderGet: 'crm.order.get',
} as const;

export type CrmQueryOperation = (typeof CRM_QUERY)[keyof typeof CRM_QUERY];

export interface CrmBusinessGateway extends BusinessGateway {
  searchCustomers(input: CustomerSearchInput): Promise<CustomerRecord[]>;
  getCustomer(input: { tenantId: string; customerId: string }): Promise<CustomerRecord | null>;
  getCredit(input: { tenantId: string; customerId: string }): Promise<CreditRecord | null>;
  getProducts(input: { tenantId: string; skus: string[] }): Promise<ProductRecord[]>;
  searchProducts(input: { tenantId: string; term?: string }): Promise<ProductRecord[]>;
  getOrder(input: { tenantId: string; orderId?: string; orderNo?: string }): Promise<OrderRecord | null>;
}
```

- [ ] **Step 3：垂直网关实现泛型 query**

在 `prisma-gateway.ts`：
- 导入 `CRM_QUERY` 与 `CrmBusinessGateway`。
- 返回类型改为 `CrmBusinessGateway`。
- 增加：

```ts
async query<T = unknown>(input: { tenantId: string; operation: string; params: Record<string, unknown> }): Promise<T> {
  const params = input.params as Record<string, never>;
  switch (input.operation) {
    case CRM_QUERY.customerSearch:
      return gateway.searchCustomers(params) as Promise<T>;
    case CRM_QUERY.customerGet:
      return gateway.getCustomer(params) as Promise<T>;
    case CRM_QUERY.creditGet:
      return gateway.getCredit(params) as Promise<T>;
    case CRM_QUERY.productsGet:
      return gateway.getProducts(params) as Promise<T>;
    case CRM_QUERY.productsSearch:
      return gateway.searchProducts(params) as Promise<T>;
    case CRM_QUERY.orderGet:
      return gateway.getOrder(params) as Promise<T>;
    default:
      throw new TefError('VALIDATION_ERROR', `unknown business query: ${input.operation}`);
  }
}
```

其中 `gateway` 是正在构造的对象（先 `const gateway = { ... } as CrmBusinessGateway; return gateway;`），确保分发调用类型化方法。

- [ ] **Step 4：契约侧类型化访问**

创建 `gateway/context.ts`：

```ts
import { TefError, type BusinessGateway, type ExecContext } from '@lymtrix/tef-core';
import type { CrmBusinessGateway } from './types';

export function requireCrmGateway(ctx: Pick<ExecContext, 'gateway'>): CrmBusinessGateway {
  const gateway = ctx.gateway as CrmBusinessGateway | undefined;
  if (!gateway) throw new TefError('INTERNAL', 'BusinessGateway is not configured');
  return gateway;
}
```

把两个契约中的 `ctx.gateway` 检查替换为 `const gateway = requireCrmGateway(ctx);`。

- [ ] **Step 5：查询工具类型化**

`tools/query.ts` 的 `QueryOptions` 改为 `gateway?: CrmBusinessGateway`；默认值仍为 `createPrismaCrmGateway(tx, principal.tenantId)`。

- [ ] **Step 6：Kit 工厂类型**

`packages/tef-mcp-kit/src/tools/contract.ts` 的 `gatewayFactory` 返回类型改为 `BusinessGateway`（泛型），并导入自 `@lymtrix/tef-core`。垂直的 `createPrismaCrmGateway` 返回 `CrmBusinessGateway`（子类型），可直接赋值。

- [ ] **Step 7：导出与测试类型**

- `verticals/crm-erp-mcp/src/index.ts` 导出 `CrmBusinessGateway`、`CRM_QUERY`、DTO 类型。
- 更新 `prisma-gateway.test.ts` 的 DTO 导入到 `./types`。
- 增加 1 个测试：`gateway.query({ operation: CRM_QUERY.customerGet, params: { customerId } })` 返回与 `getCustomer` 相同；未知 operation 抛 `VALIDATION_ERROR`。测试总数变为 309（282 单元 + 27 集成）。

- [ ] **Step 8：验证**

```bash
npx vitest run packages/tef-core verticals/crm-erp-mcp packages/tef-mcp-kit
npm run boundaries:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
```

Expected: 309 passed；boundary/typecheck/lint 通过。

---

## Task 2：文档同步与最终验收

**Files:**
- Modify: `verticals/crm-erp-mcp/src/gateway/context.ts`
- Modify: `verticals/crm-erp-mcp/src/gateway/prisma-gateway.test.ts`
- Modify: `docs/00-framework.md`
- Modify: `docs/superpowers/specs/2026-11-09-tef-extraction-design.md`
- Modify: `docs/superpowers/plans/2026-11-09-phase-b1-5-port-neutrality.md`
- Modify: `README.md`
- Modify: `docs/00-positioning.md`
- Modify: `docs/competition/挑战杯项目设计说明书.md`

- [ ] **Step 0：收口 Task 1 的 Minor**

1. `requireCrmGateway` 增加鸭子类型守卫：若 `typeof gateway.getCustomer !== 'function'`，抛 `TefError('INTERNAL', 'CRM BusinessGateway implementation is incomplete')`，避免只实现泛型 `query` 的网关在契约里触发原生 TypeError。
2. `prisma-gateway.test.ts` 的租户矩阵加入 `query` 路径：用 `CRM_QUERY.customerGet` 与不匹配 tenantId 调用 `gateway.query`，断言 `PERMISSION_DENIED` 且未触库；测试标题改为“全部公开方法”。不新增 `it`，总数保持 309。
3. 在 B1.5 计划的后续索引中注明：B2 必须为 `query` 的 params 增加 zod 白名单校验。

- [ ] **Step 1：同步测试基线**

把活跃文档中的 `308` → `309`、`281` → `282`；明确历史阶段行保留旧数字。

- [ ] **Step 2：更新端口描述**

- `docs/00-framework.md`：把 `BusinessGateway` 描述为“泛型 query + executeEffects，垂直 DTO 在 CRM 包内”；`CrmBusinessGateway` 在垂直包。
- 设计文档 §4.3/§8.2：补充“核心端口不含 CRM 字段；垂直 DTO 通过 `CrmBusinessGateway` 扩展”。
- B1.5 计划头部状态：`Phase B1.5 已完成（2026-11-09）`。

- [ ] **Step 3：最终验收**

```bash
npm run boundaries:check
npm run secrets:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
npm run build
```

Expected: 309 passed；其余全部通过。

---

## 后续计划索引

| 计划 | 内容 | 前置 |
|------|------|------|
| Phase B2 | CRM 通用 HTTP 网关 + HttpCrmGateway + conformance suite | B1.5 完成 |
| Phase B3 | TefStateStore/Clock、独立 schema、Tef Server、Docker Compose | B2 完成 |
| Phase C | P1 收尾：执行状态机、故障注入、并发与崩溃恢复 | B3 完成 |
| Phase D | P2 准备：指标埋点、fixture、eval harness 与种子样本 | C 完成 |

## 自检记录

- 规格覆盖：解决 B1 最终评审的 Important 1（核心端口垂直中立），并为 B2 的 HTTP 契约冻结做好准备。
- 占位符：无 TBD/TODO；新文件给出完整代码。
- 类型一致性：核心 `BusinessGateway` 泛型；垂直 `CrmBusinessGateway` 扩展；Kit 工厂返回核心类型。

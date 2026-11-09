# Phase B1：BusinessGateway 端口与垂直读路径改造实施计划

> **执行状态**：Phase B1 已完成（2026-11-09）。
> 任务复选框保留为原始计划记录；完成状态以本行为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `tef-core` 定义业务数据访问端口 `BusinessGateway`，用 Prisma 实现进程内版本，并让 CRM 垂直的查询工具与契约 `loadEvidence` 全部通过端口访问业务数据；为 Phase B2 的 CRM HTTP 网关与 Phase C 的跨服务执行做准备。

**Architecture:** `BusinessGateway` 是框架核心定义的只读业务数据端口；CRM 垂直提供 `PrismaCrmGateway`（进程内）与后续的 `HttpCrmGateway`。`ExecContext` 增加可选 `gateway`，由 MCP Kit 的契约运行时通过注入的工厂装配。本阶段不改变执行路径（effects 仍走 Prisma 事务），既有 304 项不变，Task 4 后基线 308。

**Tech Stack:** TypeScript 5.7、Prisma 7、Vitest 3、npm workspaces。

## Global Constraints

- 不改变运行时行为；304 个既有测试（277 单元 + 27 集成）必须全部通过；Task 4 新增测试后总数同步更新到文档。
- 旧导入路径与现有工具返回结构保持不变。
- `tef-core` 仍不依赖 Prisma、Next.js、垂直包或 MCP 实现。
- `tef-mcp-kit` 仍不依赖垂直包；网关实现由垂直包注入。
- 不修改 `strict`、`target`、`moduleResolution` 等全局 TypeScript 选项。
- 用户已授权本地提交（仅本地，不推送）。
- 本计划只覆盖 B1；B2（CRM HTTP 网关）、B3（独立存储与服务化）、C（P1 收尾）、D（P2 准备）另行成计划。

---

## Task 1：在 tef-core 定义 BusinessGateway 端口

**Files:**
- Create: `packages/tef-core/src/business-gateway.ts`
- Modify: `packages/tef-core/src/types.ts`
- Modify: `packages/tef-core/src/index.ts`

**Interfaces:**
- Produces: `BusinessGateway`、`CustomerRecord`、`ProductRecord`、`OrderRecord`、`CreditRecord`、`EffectsExecuteRequest`、`EffectsExecuteResult`
- `ExecContext` 增加可选字段 `gateway?: BusinessGateway`

- [ ] **Step 1：创建端口类型**

创建 `packages/tef-core/src/business-gateway.ts`：

```ts
import type { Effect } from './types';

/** 业务系统返回的客户快照；字段是框架可理解的通用形状，不含 CRM 专属逻辑。 */
export interface CustomerRecord {
  id: string;
  name: string;
  phone: string;
  status: string;
  customerType: string;
  creditLimit: number;
  creditUsed: number;
  overdueDays: number;
  isHighRisk: boolean;
  monthlyTransaction: number;
  onboardingStatus: string;
}

export interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  availableQty: number;
  reservedQty: number;
  unit: string;
}

export interface PaymentRecord {
  id: string;
  amount: number;
  method: string;
  status: string;
  remark?: string | null;
  dueAt?: string | null;
}

export interface OrderRecord {
  id: string;
  orderNo: string;
  customerId: string;
  customerName?: string | null;
  items: unknown;
  totalAmount: number;
  discount?: number | null;
  depositRate?: number | null;
  deposit?: number | null;
  balance: number;
  termsDays: number;
  status: string;
  traceId?: string | null;
  previewId?: string | null;
  payments: PaymentRecord[];
  createdAt: string;
}

export interface CreditRecord {
  customer: CustomerRecord;
  openOrders: Array<{
    id: string;
    orderNo: string;
    balance: number;
    termsDays: number;
    status: string;
    createdAt: string;
  }>;
}

export interface CustomerSearchInput {
  tenantId: string;
  name?: string;
  phone?: string;
  limit?: number;
}

export interface EffectsExecuteRequest {
  tenantId: string;
  idempotencyKey: string;
  previewId: string;
  traceId: string;
  expectedEvidenceVersion?: string;
  effects: Effect[];
}

export interface EffectsExecuteResult {
  ok: boolean;
  refs: Record<string, Record<string, unknown>>;
  error?: { code: 'CONFLICT' | 'INTERNAL'; message: string };
}

/**
 * 业务数据访问端口。
 *
 * 框架核心只依赖这个接口；进程内由 Prisma 实现，跨服务时由 HTTP 实现。
 * 所有方法都必须显式带 tenantId，禁止跨租户读取。
 */
export interface BusinessGateway {
  searchCustomers(input: CustomerSearchInput): Promise<CustomerRecord[]>;
  getCustomer(input: { tenantId: string; customerId: string }): Promise<CustomerRecord | null>;
  getCredit(input: { tenantId: string; customerId: string }): Promise<CreditRecord | null>;
  getProducts(input: { tenantId: string; skus: string[] }): Promise<ProductRecord[]>;
  searchProducts(input: { tenantId: string; term?: string }): Promise<ProductRecord[]>;
  getOrder(input: { tenantId: string; orderId?: string; orderNo?: string }): Promise<OrderRecord | null>;
  executeEffects(input: EffectsExecuteRequest): Promise<EffectsExecuteResult>;
}
```

- [ ] **Step 2：在 ExecContext 增加 gateway**

在 `packages/tef-core/src/types.ts` 的 `ExecContext` 接口中增加：

```ts
  /** 业务数据端口；由 MCP Kit 的运行时通过工厂注入。 */
  gateway?: import('./business-gateway').BusinessGateway;
```

保留现有 `db` 字段，避免影响执行路径。

- [ ] **Step 3：导出端口**

在 `packages/tef-core/src/index.ts` 增加：

```ts
export * from './business-gateway';
```

- [ ] **Step 4：验证**

```bash
npx vitest run packages/tef-core
npm run typecheck
npm run boundaries:check
```

Expected: core 测试通过；typecheck 0；boundary check 通过。

---

## Task 2：实现 PrismaCrmGateway 并改造查询工具

**Files:**
- Create: `verticals/crm-erp-mcp/src/gateway/prisma-gateway.ts`
- Modify: `verticals/crm-erp-mcp/src/tools/query.ts`
- Modify: `verticals/crm-erp-mcp/src/index.ts`

**Interfaces:**
- Consumes: `BusinessGateway` from `@lymtrix/tef-core`
- Produces: `createPrismaCrmGateway(tx, tenantId): BusinessGateway`
- 查询工具改为通过网关读取业务数据，返回结构不变。

- [ ] **Step 1：实现 Prisma 网关**

创建 `verticals/crm-erp-mcp/src/gateway/prisma-gateway.ts`：

```ts
import type {
  BusinessGateway,
  CreditRecord,
  CustomerRecord,
  OrderRecord,
  ProductRecord,
} from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';

function toCustomer(row: {
  id: string; name: string; phone: string; status: string; customerType: string;
  creditLimit: number; creditUsed: number; overdueDays: number; isHighRisk: boolean;
  monthlyTransaction: number; onboardingStatus: string;
}): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    customerType: row.customerType,
    creditLimit: row.creditLimit,
    creditUsed: row.creditUsed,
    overdueDays: row.overdueDays,
    isHighRisk: row.isHighRisk,
    monthlyTransaction: row.monthlyTransaction,
    onboardingStatus: row.onboardingStatus,
  };
}

function toProduct(row: {
  id: string; sku: string; name: string; unitPrice: number;
  availableQty: number; reservedQty: number; unit: string;
}): ProductRecord {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unitPrice: row.unitPrice,
    availableQty: row.availableQty,
    reservedQty: row.reservedQty,
    unit: row.unit,
  };
}

export function createPrismaCrmGateway(tx: PrismaTx, tenantId: string): BusinessGateway {
  return {
    async searchCustomers({ name, phone, limit }) {
      const rows = await tx.customer.findMany({
        where: {
          tenantId,
          OR: [
            ...(name ? [{ name: { contains: name } }] : []),
            ...(phone ? [{ phone: { contains: phone } }] : []),
          ],
        },
        take: Math.min(Math.max(limit ?? 10, 1), 50),
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map(toCustomer);
    },

    async getCustomer({ customerId }) {
      const row = await tx.customer.findFirst({ where: { id: customerId, tenantId } });
      return row ? toCustomer(row) : null;
    },

    async getCredit({ customerId }) {
      const [customer, openOrders] = await Promise.all([
        tx.customer.findFirst({ where: { id: customerId, tenantId } }),
        tx.order.findMany({
          where: { tenantId, customerId, status: { in: ['pending', 'confirmed', 'shipped'] } },
          select: { id: true, orderNo: true, balance: true, termsDays: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);
      if (!customer) return null;
      const result: CreditRecord = {
        customer: toCustomer(customer),
        openOrders: openOrders.map((order) => ({
          ...order,
          createdAt: order.createdAt.toISOString(),
        })),
      };
      return result;
    },

    async getProducts({ skus }) {
      if (skus.length === 0) return [];
      const rows = await tx.product.findMany({ where: { tenantId, sku: { in: skus } } });
      return rows.map(toProduct);
    },

    async searchProducts({ term }) {
      const rows = await tx.product.findMany({
        where: {
          tenantId,
          ...(term ? { OR: [{ sku: { contains: term } }, { name: { contains: term } }] } : {}),
        },
        orderBy: { sku: 'asc' },
        take: 50,
      });
      return rows.map(toProduct);
    },

    async getOrder({ orderId, orderNo }) {
      const row = await tx.order.findFirst({
        where: {
          tenantId,
          ...(orderId ? { id: orderId } : { orderNo: orderNo as string }),
        },
        include: { payments: true, customer: { select: { id: true, name: true } } },
      });
      if (!row) return null;
      const result: OrderRecord = {
        id: row.id,
        orderNo: row.orderNo,
        customerId: row.customerId,
        customerName: row.customer?.name ?? null,
        items: row.items,
        totalAmount: row.totalAmount,
        discount: row.discount,
        depositRate: row.depositRate,
        deposit: row.deposit,
        balance: row.balance,
        termsDays: row.termsDays,
        status: row.status,
        traceId: row.traceId,
        previewId: row.previewId,
        payments: row.payments.map((payment) => ({
          id: payment.id,
          amount: payment.amount,
          method: payment.method,
          status: payment.status,
          remark: payment.remark,
          dueAt: payment.dueAt?.toISOString() ?? null,
        })),
        createdAt: row.createdAt.toISOString(),
      };
      return result;
    },

    async executeEffects() {
      throw new Error('PrismaCrmGateway.executeEffects is implemented in Phase B2/C');
    },
  };
}
```

**租户一致性要求**：每个方法必须校验 `input.tenantId === tenantId`（闭包绑定值），不一致时抛出 `TefError('PERMISSION_DENIED', 'gateway tenant mismatch')`；禁止静默使用闭包租户。这样进程内实现与后续 HTTP 实现的租户语义一致。

**查询守卫**：`getOrder` 必须继续要求 `orderId` 或 `orderNo` 至少一个；两者都缺省时返回 `null` 或抛 `TefError('VALIDATION_ERROR')`，不得用 tenantId 单独查询首条订单。

- [ ] **Step 2：查询工具改用网关**

在 `tools/query.ts`：
- 增加 `import { createPrismaCrmGateway } from '../gateway/prisma-gateway';`
- `QueryOptions` 增加 `gateway?: BusinessGateway`。
- 每个工具在 `withTenantScope` 内先取网关：

```ts
const gateway = options.gateway ?? createPrismaCrmGateway(tx, principal.tenantId);
```

- `customerSearch` 用 `gateway.searchCustomers({ tenantId: principal.tenantId, name, phone, limit })` 替换 `tx.customer.findMany`。
- `customerGet` 用 `gateway.getCustomer({ tenantId, customerId })`。
- `creditGet` 用 `gateway.getCredit({ tenantId, customerId })`。
- `inventoryCheck` 用 `gateway.searchProducts({ tenantId, term })`。
- `orderGet` 用 `gateway.getOrder({ tenantId, orderId, orderNo })`。
- 保持返回结构、字段名、审计事件与错误码不变。
- `customerSearch` 的候选列表需要 `creditAvailable`、`status` 与打码手机号；从 `CustomerRecord` 计算/映射，逻辑与旧实现一致。
- **必须继续调用 `maskPhone`**：网关返回原始手机号，工具响应进入模型上下文前必须打码，不得把 `CustomerRecord.phone` 直接返回。

- [ ] **Step 3：导出网关**

在 `verticals/crm-erp-mcp/src/index.ts` 增加：

```ts
export { createPrismaCrmGateway } from './gateway/prisma-gateway';
```

- [ ] **Step 4：验证**

```bash
npx vitest run verticals/crm-erp-mcp src/mcp-server
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
```

Expected: 304 passed（277 单元 + 27 集成）；lint 0 错误 / 28 警告。

---

## Task 3：契约 loadEvidence 改用网关

**Files:**
- Modify: `verticals/crm-erp-mcp/src/contracts/credit-order/create-order.ts`
- Modify: `verticals/crm-erp-mcp/src/contracts/credit-order/compensate-order.ts`
- Modify: `verticals/crm-erp-mcp/src/tools/order.ts`
- Modify: `packages/tef-mcp-kit/src/tools/contract.ts`
- Modify: `packages/tef-mcp-kit/src/principal.ts`

**Interfaces:**
- Consumes: `ExecContext.gateway`、`createPrismaCrmGateway`
- Produces: 契约 `loadEvidence` 只通过 `ctx.gateway` 读取业务数据；`previewContract`/`executeContract` 接受可选 `gatewayFactory`。

- [ ] **Step 1：MCP Kit 注入网关**

在 `packages/tef-mcp-kit/src/principal.ts`：
- `ExecContextOptions` 增加：

```ts
gateway?: import('@lymtrix/tef-core').BusinessGateway;
```

- 返回的 `ExecContext` 增加 `gateway: options.gateway`。

在 `packages/tef-mcp-kit/src/tools/contract.ts`：
- `ContractWriteOptions` 增加：

```ts
gatewayFactory?: (tx: PrismaTx, tenantId: string) => import('@lymtrix/tef-core').BusinessGateway;
```

- `buildExecContext(principal, tx, { traceId, now, gateway: options.gatewayFactory?.(tx, principal.tenantId) })`。

- [ ] **Step 2：垂直写入工具注入 Prisma 网关**

在 `verticals/crm-erp-mcp/src/tools/order.ts`：
- 导入 `createPrismaCrmGateway`。
- 在 `orderPreviewCreate` / `orderExecuteCreate` / `orderPreviewCompensate` / `orderExecuteCompensate` 的 `options` 中增加：

```ts
gatewayFactory: createPrismaCrmGateway,
```

保留调用方已有的 `writeOptions` 字段。

- [ ] **Step 3：改造 create_order.loadEvidence**

在 `create-order.ts`：
- `loadEvidence(params, ctx)` 中：

```ts
const gateway = ctx.gateway;
if (!gateway) throw new TefError('INTERNAL', 'BusinessGateway is not configured');
const [customerRow, productRows] = await Promise.all([
  gateway.getCustomer({ tenantId: ctx.tenantId, customerId: params.customerId }),
  gateway.getProducts({ tenantId: ctx.tenantId, skus }),
]);
```

- 用 `customerRow` / `productRows` 映射出原来的 `CreateOrderEvidence`；字段名与旧实现一致（`creditAvailable = creditLimit - creditUsed` 等）。
- 移除对 `ctx.db.customer/product` 的直接访问。

- [ ] **Step 4：改造 compensate_order.loadEvidence**

在 `compensate-order.ts`：
- 用 `ctx.gateway.getOrder({ tenantId, orderId })` 获取订单与付款。
- 用 `ctx.gateway.getCustomer` / `getProducts` 获取客户与商品。
- 原始预览快照仍从 `ctx.db.previewSnapshot.findFirst` 读取（TEF 治理状态，不属于业务网关）。
- 保持 `CompensateOrderEvidence` 的字段与映射逻辑不变。

- [ ] **Step 5：验证**

```bash
npx vitest run verticals/crm-erp-mcp packages/tef-mcp-kit src/mcp-server
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
```

Expected: 304 passed；lint 0 错误 / 28 警告。

---

## Task 4：文档与最终验收

**Files:**
- Create: `verticals/crm-erp-mcp/src/gateway/prisma-gateway.test.ts`
- Modify: `verticals/crm-erp-mcp/src/contracts/credit-order/create-order.test.ts`
- Modify: `verticals/crm-erp-mcp/src/contracts/credit-order/compensate-order.test.ts`
- Modify: `docs/00-framework.md`
- Modify: `docs/superpowers/specs/2026-11-09-tef-extraction-design.md`
- Modify: `docs/superpowers/plans/2026-11-09-phase-b1-business-gateway.md`

- [ ] **Step 0：补网关与契约 fail-closed 测试**

创建 `verticals/crm-erp-mcp/src/gateway/prisma-gateway.test.ts`，至少覆盖：

1. 7 个网关方法在 `input.tenantId !== 绑定的 tenantId` 时抛 `TefError('PERMISSION_DENIED', 'gateway tenant mismatch')`，且不调用 tx 上的任何方法（用 Proxy 或全抛错 fake tx 证明）。
2. `getCustomer` 与 `getOrder` 的响应映射保留关键字段（客户额度字段、订单 payments/dueAt、previewId）。

在 `create-order.test.ts` / `compensate-order.test.ts` 各增加一个测试：

3. `loadEvidence` 在 `ctx.gateway` 缺失时抛 `TefError('INTERNAL', 'BusinessGateway is not configured')`，并证明错误发生在访问 `ctx.db` 之前。

新增 4 个测试后，基线变为 308（281 单元 + 27 集成）。同步更新所有活跃文档中的 304/277。

- [ ] **Step 1：更新设计文档状态与实现映射**

- 设计文档头部状态改为 `实施中（Phase A1、A2、B1 已完成，B2–D 待实施）`。
- `docs/00-framework.md` 的代码映射增加 `packages/tef-core/src/business-gateway.ts` 与 `verticals/crm-erp-mcp/src/gateway/prisma-gateway.ts`。
- 说明 `BusinessGateway` 是 Phase B2 HTTP 网关的端口；本阶段仍使用进程内 Prisma 实现。

- [ ] **Step 2：标记 B1 计划完成**

在 B1 计划标题下增加：

```markdown
> **执行状态**：Phase B1 已完成（2026-11-09）。
```

- [ ] **Step 3：最终验收**

```bash
npm run boundaries:check
npm run secrets:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
npm run build
```

Expected: boundary check 通过；secrets 通过；typecheck 0；lint 0 错误 / 28 警告；308 passed；build 成功。

---

## 后续计划索引

| 计划 | 内容 | 前置 |
|------|------|------|
| Phase B2 | CRM 通用 HTTP 网关（query/evidence/effects）+ HttpCrmGateway + 可复用一致性测试套件 | B1 完成 |
| Phase B3 | `TefStateStore`/`Clock` 端口、TEF/Runtime 独立 schema、TEF Server 进程、JWT/对话/确认 API、Docker Compose | B2 完成 |
| Phase B4 | 三进程 e2e 闭环与文档 | B3 完成 |
| Phase C | P1 收尾：执行状态机、故障注入、并发与崩溃恢复 | B4 完成 |
| Phase D | P2 准备：指标埋点、fixture、eval harness 与种子样本 | C 完成 |

## 自检记录

- 规格覆盖：对应设计文档 §8.2 的 B1 端口定义与 B2 的垂直 HTTP 读路径前置；HTTP 网关与 effects 执行留待 B2/C。
- 占位符：无 TBD/TODO；新文件给出完整代码，修改类步骤给出精确映射规则。
- 类型一致性：`BusinessGateway` 在 core 定义；Prisma 实现在垂直包；MCP Kit 只通过 `gatewayFactory` 注入，不依赖垂直包。

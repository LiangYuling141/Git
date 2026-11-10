# Phase A2：tef-mcp-kit、CRM 垂直 MCP 与 tef-runtime 提取实施计划

> **执行状态**：Phase A2 已完成（2026-11-09，commits 21a9433..76abf8c + 最终边界修复（本轮））。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MCP 工具层、CRM 垂直实现与 Agent Runtime 从单一 `src/` 应用拆成三个 workspace 包，保持运行时行为不变，最终 304 个测试通过，且既有测试不减少。

**Architecture:** `@lymtrix/tef-mcp-kit` 提供通用 MCP Server 工厂、治理工具、契约运行时与状态存储；`@lymtrix/vertical-crm-erp` 用 kit 注册 CRM 查询/订单工具与契约；`@lymtrix/tef-runtime` 承载意图解析、LLM 客户端、TaskState 与编排，并通过注入的会话连接器调用 MCP。旧路径全部保留 re-export shim。

**Tech Stack:** Node 22、npm workspaces、TypeScript 5.7、Vitest 3、ESLint 9、MCP SDK 1.32.2、Next.js 16。

## Global Constraints

- 不改变运行时行为；旧导入路径 `@/mcp-server/*`、`@/tef/*`、`@/agent-runtime/*`、`@/lib/ai/LLMClient` 必须继续可用。
- 每个任务结束时 `npm run typecheck`、`npm run lint` 为 0 错误；`npm test` 通过数不得低于 277 单元测试。
- 最后一项任务执行 `TEF_DB_TESTS=1 npm test`，必须 304 全部通过；`npm run build` 必须成功。
- 包名固定：`@lymtrix/tef-mcp-kit`、`@lymtrix/vertical-crm-erp`、`@lymtrix/tef-runtime`。
- 不修改 `strict`、`target`、`moduleResolution` 等全局 TypeScript 选项。
- 默认不执行 git commit；只有用户明确授权后才提交（本阶段已获授权，仅本地提交，不推送）。
- 本计划只覆盖 Phase A2；Phase B（服务化/API）、C（P1 收尾）、D（P2 准备）另行成计划。

---

## Task 1：建立三个 workspace 包与解析别名

**Files:**
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `next.config.ts`
- Create: `packages/tef-mcp-kit/package.json`
- Create: `packages/tef-mcp-kit/src/index.ts`
- Create: `packages/tef-runtime/package.json`
- Create: `packages/tef-runtime/src/index.ts`
- Create: `verticals/crm-erp-mcp/package.json`
- Create: `verticals/crm-erp-mcp/src/index.ts`

**Interfaces:**
- Consumes: `@lymtrix/tef-core`（已有）
- Produces: 三个可解析的 workspace 包骨架。

- [ ] **Step 1：创建包清单**

`packages/tef-mcp-kit/package.json`：

```json
{
  "name": "@lymtrix/tef-mcp-kit",
  "version": "0.1.0",
  "private": true,
  "description": "LyMtrix-TEF MCP toolkit: server factory, governance tools, contract runtime.",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "dependencies": {
    "@lymtrix/tef-core": "*",
    "@modelcontextprotocol/sdk": "^1.32.2",
    "zod": "^4.6.7"
  }
}
```

`packages/tef-runtime/package.json`：

```json
{
  "name": "@lymtrix/tef-runtime",
  "version": "0.1.0",
  "private": true,
  "description": "LyMtrix-TEF agent runtime: context, intent, LLM client and task state.",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "dependencies": {
    "@lymtrix/tef-core": "*",
    "@lymtrix/tef-mcp-kit": "*",
    "zod": "^4.6.7"
  }
}
```

`verticals/crm-erp-mcp/package.json`：

```json
{
  "name": "@lymtrix/vertical-crm-erp",
  "version": "0.1.0",
  "private": true,
  "description": "LyMtrix-TEF CRM-ERP vertical MCP: query tools and credit-order contracts.",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "dependencies": {
    "@lymtrix/tef-core": "*",
    "@lymtrix/tef-mcp-kit": "*",
    "@modelcontextprotocol/sdk": "^1.32.2",
    "zod": "^4.6.7"
  }
}
```

三个 `src/index.ts` 先写：

```ts
export {};
```

- [ ] **Step 2：更新 tsconfig 路径**

在 `tsconfig.json` 的 `paths` 中追加：

```json
"@lymtrix/tef-mcp-kit": ["./packages/tef-mcp-kit/src/index.ts"],
"@lymtrix/tef-mcp-kit/*": ["./packages/tef-mcp-kit/src/*"],
"@lymtrix/tef-runtime": ["./packages/tef-runtime/src/index.ts"],
"@lymtrix/tef-runtime/*": ["./packages/tef-runtime/src/*"],
"@lymtrix/vertical-crm-erp": ["./verticals/crm-erp-mcp/src/index.ts"],
"@lymtrix/vertical-crm-erp/*": ["./verticals/crm-erp-mcp/src/*"]
```

- [ ] **Step 3：更新 Vitest 别名与 include**

在 `vitest.config.ts` 的 `alias` 数组中，按以下顺序追加（放在 `@` 之前）：

```ts
{
  find: /^@lymtrix\/tef-mcp-kit\/(.*)$/,
  replacement: `${fileURLToPath(new URL('./packages/tef-mcp-kit/src', import.meta.url))}/$1`,
},
{
  find: '@lymtrix/tef-mcp-kit',
  replacement: fileURLToPath(new URL('./packages/tef-mcp-kit/src/index.ts', import.meta.url)),
},
{
  find: /^@lymtrix\/tef-runtime\/(.*)$/,
  replacement: `${fileURLToPath(new URL('./packages/tef-runtime/src', import.meta.url))}/$1`,
},
{
  find: '@lymtrix/tef-runtime',
  replacement: fileURLToPath(new URL('./packages/tef-runtime/src/index.ts', import.meta.url)),
},
{
  find: /^@lymtrix\/vertical-crm-erp\/(.*)$/,
  replacement: `${fileURLToPath(new URL('./verticals/crm-erp-mcp/src', import.meta.url))}/$1`,
},
{
  find: '@lymtrix/vertical-crm-erp',
  replacement: fileURLToPath(new URL('./verticals/crm-erp-mcp/src/index.ts', import.meta.url)),
},
```

把 `test.include` 改为：

```ts
include: ['src/**/*.test.ts', 'packages/**/*.test.ts', 'verticals/**/*.test.ts', 'tests/**/*.test.ts'],
```

- [ ] **Step 4：更新 Next 转译列表**

`next.config.ts`：

```ts
const nextConfig: NextConfig = {
  transpilePackages: [
    '@lymtrix/tef-core',
    '@lymtrix/tef-mcp-kit',
    '@lymtrix/tef-runtime',
    '@lymtrix/vertical-crm-erp',
  ],
};
```

- [ ] **Step 5：安装并验证**

Run:

```bash
npm install
npm run typecheck
npm test
```

Expected: 安装成功；typecheck 0；`268 passed | 27 skipped (295)`（A2 前基线）。

- [ ] **Step 6：检查点**

Run:

```bash
git status --short
```

Expected: 仅本任务文件变更；不执行提交（除非进入任务提交步骤）。

---

## Task 2：提取 tef-mcp-kit

**Files:**
- Move: `src/mcp-server/envelope.ts` → `packages/tef-mcp-kit/src/envelope.ts`
- Move: `src/mcp-server/principal.ts` → `packages/tef-mcp-kit/src/principal.ts`
- Create: `packages/tef-mcp-kit/src/transport.ts`（从旧文件复制并改造为工厂注入）
- Move: `src/mcp-server/tools/contract.ts` → `packages/tef-mcp-kit/src/tools/contract.ts`
- Move: `src/mcp-server/tools/confirmation.ts` → `packages/tef-mcp-kit/src/tools/confirmation.ts`
- Move: `src/mcp-server/tools/audit.ts` → `packages/tef-mcp-kit/src/tools/audit.ts`
- Move: `src/tef/preview-store.ts` + test → `packages/tef-mcp-kit/src/preview-store.ts`
- Move: `src/tef/token.ts` + test → `packages/tef-mcp-kit/src/token.ts`
- Move: `src/tef/audit-chain.ts` + test → `packages/tef-mcp-kit/src/audit-chain.ts`
- Move: `src/tef/tenant.ts` → `packages/tef-mcp-kit/src/tenant.ts`
- Move: `src/tef/tenant-scope.ts` → `packages/tef-mcp-kit/src/tenant-scope.ts`
- Create: `packages/tef-mcp-kit/src/server.ts`（通用工厂）
- Create: `packages/tef-mcp-kit/src/prisma.ts`（过渡期 Prisma 事务类型）
- Create: `packages/tef-mcp-kit/src/index.ts`
- Create: 旧路径 shim

**Interfaces:**
- Consumes: `@lymtrix/tef-core`
- Produces:
  - `createTefServer(options, registerVertical?)`
  - `connectTefClient(options, createServer)`
  - `TefServerOptions`、`TefClientSession`、`VerticalToolContext`、`VerticalToolRegistrar`、`Principal`
  - `approveOutOfBand`、`visibleToolsFor`
  - 治理工具 `confirmation.approve` / `confirmation.reject` / `audit.trace` / `policy.get`

- [ ] **Step 1：移动文件**

```bash
mkdir -p packages/tef-mcp-kit/src/tools
git mv src/mcp-server/envelope.ts packages/tef-mcp-kit/src/envelope.ts
git mv src/mcp-server/principal.ts packages/tef-mcp-kit/src/principal.ts
git mv src/mcp-server/tools/contract.ts packages/tef-mcp-kit/src/tools/contract.ts
git mv src/mcp-server/tools/confirmation.ts packages/tef-mcp-kit/src/tools/confirmation.ts
git mv src/mcp-server/tools/audit.ts packages/tef-mcp-kit/src/tools/audit.ts
git mv src/tef/preview-store.ts packages/tef-mcp-kit/src/preview-store.ts
git mv src/tef/preview-store.test.ts packages/tef-mcp-kit/src/preview-store.test.ts
git mv src/tef/token.ts packages/tef-mcp-kit/src/token.ts
git mv src/tef/token.test.ts packages/tef-mcp-kit/src/token.test.ts
git mv src/tef/audit-chain.ts packages/tef-mcp-kit/src/audit-chain.ts
git mv src/tef/audit-chain.test.ts packages/tef-mcp-kit/src/audit-chain.test.ts
git mv src/tef/tenant.ts packages/tef-mcp-kit/src/tenant.ts
git mv src/tef/tenant-scope.ts packages/tef-mcp-kit/src/tenant-scope.ts
```

- [ ] **Step 2：更新包内导入**

在移动后的文件中：

统一映射规则：

| 旧导入 | 新导入 |
|--------|--------|
| `@/tef/{types,errors,hashing,canonical,redaction,contract-engine,contract-registry,effect-executor}` | `@lymtrix/tef-core` 或 `@lymtrix/tef-core/<module>` |
| `@/tef/{tenant,token,preview-store,audit-chain,tenant-scope}` | `./tenant`、`./token`、`./preview-store`、`./audit-chain`、`./tenant-scope`（kit 内） |
| `@/mcp-server/{envelope,principal}`、`@/mcp-server/tools/{contract,confirmation,audit}` | `./envelope`、`./principal`、`./tools/<name>`（kit 内） |
| `@/tef/types` 的 `PrismaTx` | `./prisma` 或 `@lymtrix/tef-mcp-kit` |

具体步骤：

1. 核心模块导入改为 `@lymtrix/tef-core`：
   - `contract-engine`、`contract-registry`、`effect-executor`、`errors`、`redaction`、`types`、`hashing`、`canonical`。
2. 包内文件保持相对导入（`./envelope`、`./principal`、`./token` 等）。
3. 移动后的测试文件中，`./errors`、`./hashing`、`./redaction`、`./canonical` 改为 `@lymtrix/tef-core`；`./preview-store`、`./token`、`./audit-chain` 保持相对导入。
4. `PrismaTx` 不再从 `@/tef/types` 获取。创建 `packages/tef-mcp-kit/src/prisma.ts`：

```ts
import type { Prisma } from '@/generated/prisma';

/** 过渡期事务类型；Phase B 拆独立存储后由存储适配器提供。 */
export type PrismaTx = Prisma.TransactionClient;
```

   把 `contract.ts`、`principal.ts`、`tenant-scope.ts` 及垂直包中的 `PrismaTx` 导入改为 `./prisma` 或 `@lymtrix/tef-mcp-kit`。
5. 下列过渡依赖暂时保留：
   - `@/lib/prisma`、`@/generated/prisma`（Phase B 再拆独立存储）。
6. `tools/audit.ts` 的 `policyGet` 仍需读取 tenant/whitelist，使用 `./tenant` 与 `./tenant-scope`。

Run `npm run typecheck` after the import rewrite; fix only path errors, no behavior changes.

- [ ] **Step 3：新增通用 Server 工厂**

创建 `packages/tef-mcp-kit/src/server.ts`：

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canCallTool, toolsForClient } from './tenant';
import { loadTokenSecret } from './token';
import { envelopeToToolResult, fail } from './envelope';
import type { Principal } from './principal';
import { auditTrace, policyGet } from './tools/audit';
import { confirmationApprove, confirmationReject } from './tools/confirmation';
import type { ContractWriteOptions } from './tools/contract';

export interface TefServerOptions {
  principal: Principal;
  traceId: string;
  secret?: string;
}

export interface VerticalToolContext {
  server: McpServer;
  principal: Principal;
  traceId: string;
  register: (tool: string) => boolean;
  writeOptions: ContractWriteOptions;
  queryOptions: { traceId: string };
}

export type VerticalToolRegistrar = (context: VerticalToolContext) => void;

export function createTefServer(
  options: TefServerOptions,
  registerVertical?: VerticalToolRegistrar,
): McpServer {
  const { principal, traceId } = options;
  const secret = options.secret ?? loadTokenSecret();
  const writeOptions = { traceId, secret };
  const queryOptions = { traceId };

  const server = new McpServer({ name: 'lymtrix-tef', version: '0.1.0' });
  const visible = new Set(toolsForClient(principal.clientKind).filter((tool) => canCallTool(principal.role, tool)));
  const register = (tool: string): boolean => visible.has(tool);

  if (register('confirmation.approve')) {
    server.registerTool(
      'confirmation.approve',
      {
        title: '人工批准',
        description:
          'Human approval of an L2 confirmation token. Returns the server-side diff and evidence so the approver ' +
          'sees exactly what was proposed. Not visible to the agent runtime.',
        inputSchema: { confirmation_token: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) =>
        envelopeToToolResult(await confirmationApprove(principal, { confirmation_token: args.confirmation_token }, writeOptions)),
    );
  }

  if (register('confirmation.reject')) {
    server.registerTool(
      'confirmation.reject',
      {
        title: '人工拒绝',
        description: 'Human rejection of a confirmation token. Revokes the underlying preview snapshot.',
        inputSchema: { confirmation_token: z.string().min(1), reason: z.string().max(500).optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) =>
        envelopeToToolResult(
          await confirmationReject(
            principal,
            { confirmation_token: args.confirmation_token, reason: args.reason },
            writeOptions,
          ),
        ),
    );
  }

  if (register('audit.trace')) {
    server.registerTool(
      'audit.trace',
      {
        title: '回放决策链',
        description:
          'Replay the full decision chain for a trace, together with the hash-chain verification result for this tenant.',
        inputSchema: { traceId: z.string().optional() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await auditTrace(principal, { traceId: args.traceId ?? traceId })),
    );
  }

  if (register('policy.get')) {
    server.registerTool(
      'policy.get',
      {
        title: '读取策略',
        description: 'Read tenant thresholds, the caller role, and the tool scope visible to this client.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => envelopeToToolResult(await policyGet(principal)),
    );
  }

  registerVertical?.({ server, principal, traceId, register, writeOptions, queryOptions });
  return server;
}

/** 供人工确认 UI 直接调用治理工具，不必经过 MCP 传输。 */
export async function approveOutOfBand(
  principal: Principal,
  token: string,
  traceId: string,
  secret = loadTokenSecret(),
) {
  if (!canCallTool(principal.role, 'confirmation.approve') || !toolsForClient(principal.clientKind).includes('confirmation.approve')) {
    return fail('PERMISSION_DENIED', `client kind ${principal.clientKind} cannot approve confirmations`);
  }
  return confirmationApprove(principal, { confirmation_token: token }, { traceId, secret });
}

export function visibleToolsFor(principal: Principal): string[] {
  return toolsForClient(principal.clientKind).filter((tool) => canCallTool(principal.role, tool));
}
```

- [ ] **Step 4：创建 kit 版 connectTefClient**

创建 `packages/tef-mcp-kit/src/transport.ts`（复制原 `src/mcp-server/transport.ts` 的实现，只增加 `createServer` 参数）：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Envelope } from '@lymtrix/tef-core';
import type { TefServerOptions } from './server';

export type TefServerFactory = (options: TefServerOptions) => McpServer;

export interface TefClientSession {
  client: Client;
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<Envelope>;
  close(): Promise<void>;
}

export async function connectTefClient(
  options: TefServerOptions,
  createServer: TefServerFactory,
): Promise<TefClientSession> {
  const server = createServer(options);
  // 其余实现原样保留
}
```

`createServer` 必须显式传入，避免 kit 反向依赖任何垂直包。

- [ ] **Step 5：创建 kit 入口**

`packages/tef-mcp-kit/src/index.ts`：

```ts
export {
  createTefServer,
  approveOutOfBand,
  visibleToolsFor,
  type TefServerOptions,
  type VerticalToolContext,
  type VerticalToolRegistrar,
} from './server';
export { connectTefClient, type TefClientSession, type TefServerFactory } from './transport';
export { buildExecContext, type Principal, type ExecContextOptions } from './principal';
export { envelopeToToolResult, errorToEnvelope, ok, fail, blocked, conflict, needsConfirmation } from './envelope';
export { auditTrace, policyGet } from './tools/audit';
export { confirmationApprove, confirmationReject } from './tools/confirmation';
export { previewContract, executeContract, type ContractWriteOptions, type AdapterFactory } from './tools/contract';
export { previewStore } from './preview-store';
export { tokenStore, loadTokenSecret } from './token';
export { auditChain } from './audit-chain';
export { withTenantScope, withTenantRead } from './tenant-scope';
export { toolsForClient, canCallTool, resolveTenantContext, toThresholdRecord } from './tenant';
export type { PrismaTx } from './prisma';
```

- [ ] **Step 6：旧路径 shim**

用 Write 创建：

`src/mcp-server/envelope.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/envelope';
```

`src/mcp-server/principal.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/principal';
```

`src/mcp-server/tools/contract.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/tools/contract';
```

`src/mcp-server/tools/confirmation.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/tools/confirmation';
```

`src/mcp-server/tools/audit.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/tools/audit';
```

`src/tef/preview-store.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/preview-store';
```

`src/tef/token.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/token';
```

`src/tef/audit-chain.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/audit-chain';
```

`src/tef/tenant.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/tenant';
```

`src/tef/tenant-scope.ts`：

```ts
export * from '@lymtrix/tef-mcp-kit/tenant-scope';
```

`src/tef/types.ts`（把 PrismaTx 来源改到 kit）：

```ts
export * from '@lymtrix/tef-core/types';
export type { PrismaTx } from '@lymtrix/tef-mcp-kit';
```

- [ ] **Step 7：保留旧 transport**

本任务**不修改** `src/mcp-server/transport.ts`。它仍然从旧的 `src/mcp-server/server.ts` 引用 `createTefServer`，因此 `server.test.ts` 的单参数调用保持可用；Task 3 再把旧 transport 替换为 CRM 垂直连接器的 shim。

- [ ] **Step 8：验证**

```bash
npx vitest run packages/tef-mcp-kit src/mcp-server/server.test.ts
npm run typecheck
npm test
```

Expected: kit 测试（preview-store 10、token 26、audit-chain 25）与 server.test.ts（14）通过；全量 295（A2 前基线）。

---

## Task 3：提取 CRM 垂直 MCP

**Files:**
- Move: `src/mcp-server/tools/query.ts` → `verticals/crm-erp-mcp/src/tools/query.ts`
- Move: `src/mcp-server/tools/order.ts` → `verticals/crm-erp-mcp/src/tools/order.ts`
- Move: `src/contracts/credit-order/*` → `verticals/crm-erp-mcp/src/contracts/credit-order/`
- Create: `verticals/crm-erp-mcp/src/server.ts`
- Create: `verticals/crm-erp-mcp/src/index.ts`
- Create: 旧路径 shim

**Interfaces:**
- Consumes: `@lymtrix/tef-mcp-kit` 的工厂与契约运行时、`@lymtrix/tef-core` 的类型
- Produces:
  - `createCrmErpServer(options): McpServer`
  - `connectCrmErpClient(options): Promise<TefClientSession>`
  - `customerSearch/customerGet/creditGet/inventoryCheck/orderGet`
  - `orderPreviewCreate/orderExecuteCreate/orderPreviewCompensate/orderExecuteCompensate`
  - `createCreditOrderAdapters/registerCreditOrderContracts`

- [ ] **Step 1：移动文件**

```bash
mkdir -p verticals/crm-erp-mcp/src/tools verticals/crm-erp-mcp/src/contracts
git mv src/mcp-server/tools/query.ts verticals/crm-erp-mcp/src/tools/query.ts
git mv src/mcp-server/tools/order.ts verticals/crm-erp-mcp/src/tools/order.ts
git mv src/contracts/credit-order verticals/crm-erp-mcp/src/contracts/credit-order
```

- [ ] **Step 2：更新导入**

- `tools/query.ts`：`../envelope`、`../principal` 改为 `@lymtrix/tef-mcp-kit` 导出；`@/tef/*` 改为 `@lymtrix/tef-core` 或 mcp-kit。
- `tools/order.ts`：`./contract` 改为 `@lymtrix/tef-mcp-kit` 的 `previewContract/executeContract`；契约路径改为 `../contracts/credit-order`；`PrismaTx` 从 `@lymtrix/tef-mcp-kit` 导入。
- 契约与适配器：`@/tef/*` 改为 `@lymtrix/tef-core`；`@/generated/prisma` 保留（垂直暂时使用应用 Prisma）。
- 契约测试移动到 `verticals/crm-erp-mcp/src/contracts/credit-order/` 并更新 import。

- [ ] **Step 3：创建垂直 Server 工厂**

创建 `verticals/crm-erp-mcp/src/server.ts`：

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createTefServer,
  connectTefClient,
  envelopeToToolResult,
  type TefClientSession,
  type TefServerOptions,
  type VerticalToolContext,
} from '@lymtrix/tef-mcp-kit';
import {
  orderExecuteCompensate,
  orderExecuteCreate,
  orderPreviewCompensate,
  orderPreviewCreate,
} from './tools/order';
import { creditGet, customerGet, customerSearch, inventoryCheck, orderGet } from './tools/query';

const ORDER_ITEM_SHAPE = {
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
};

function registerCrmErpTools({ server, principal, register, writeOptions, queryOptions }: VerticalToolContext): void {
  if (register('customer.search')) {
    server.registerTool(
      'customer.search',
      {
        title: '搜索客户',
        description:
          'Search customers in the current tenant by name or phone. Returns a candidate list with matchReason. ' +
          'When more than one candidate matches, ask the user to disambiguate before proposing any write.',
        inputSchema: {
          name: z.string().optional(),
          phone: z.string().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await customerSearch(principal, args, queryOptions)),
    );
  }

  // customer.get / credit.get / inventory.check / order.get 的注册块从原 server.ts 原样搬入。

  if (register('order.preview_create')) {
    server.registerTool(
      'order.preview_create',
      {
        title: '预览赊账订单',
        description:
          'Validate and preview an order creation. Returns diff, risk, reasons, preview_id and a one-time ' +
          'confirmation_token. Does not write business data. For risk L2 the token only becomes usable after a ' +
          'human approves it through a separate client; this tool cannot approve it.',
        inputSchema: {
          customerId: z.string().min(1),
          items: z.array(z.object(ORDER_ITEM_SHAPE)).min(1),
          discount: z.number().nonnegative().optional(),
          depositRate: z.number().min(0).max(1).optional(),
          termsDays: z.number().int().min(0).optional(),
          remark: z.string().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await orderPreviewCreate(principal, args, writeOptions)),
    );
  }

  // order.execute_create / order.preview_compensate / order.execute_compensate 的注册块原样搬入。
}

export function createCrmErpServer(options: TefServerOptions): McpServer {
  return createTefServer(options, registerCrmErpTools);
}

export function connectCrmErpClient(options: TefServerOptions): Promise<TefClientSession> {
  return connectTefClient(options, createCrmErpServer);
}
```

实现时必须把原 `server.ts` 中 `customer.get`、`credit.get`、`inventory.check`、`order.get`、`order.execute_create`、`order.preview_compensate`、`order.execute_compensate` 的完整注册块搬入，不得遗漏。

- [ ] **Step 4：创建垂直入口**

`verticals/crm-erp-mcp/src/index.ts`：

```ts
export { createCrmErpServer, connectCrmErpClient } from './server';
export {
  creditGet,
  customerGet,
  customerSearch,
  inventoryCheck,
  maskPhone,
  orderGet,
} from './tools/query';
export {
  orderExecuteCompensate,
  orderExecuteCreate,
  orderPreviewCompensate,
  orderPreviewCreate,
} from './tools/order';
export { createCreditOrderAdapters, registerCreditOrderContracts } from './contracts/credit-order';
```

- [ ] **Step 5：旧路径 shim**

`src/mcp-server/server.ts`：

```ts
export { createCrmErpServer as createTefServer } from '@lymtrix/vertical-crm-erp';
export {
  approveOutOfBand,
  visibleToolsFor,
  type TefServerOptions,
} from '@lymtrix/tef-mcp-kit';
```

`src/mcp-server/transport.ts`（替换 Task 2 保留的旧 transport）：

```ts
export { connectCrmErpClient as connectTefClient } from '@lymtrix/vertical-crm-erp';
export type { TefClientSession } from '@lymtrix/tef-mcp-kit';
```

`src/mcp-server/tools/query.ts`：

```ts
export * from '@lymtrix/vertical-crm-erp/tools/query';
```

`src/mcp-server/tools/order.ts`：

```ts
export * from '@lymtrix/vertical-crm-erp/tools/order';
```

`src/contracts/credit-order/index.ts`：

```ts
export * from '@lymtrix/vertical-crm-erp/contracts/credit-order';
```

`src/contracts/credit-order/adapters.ts`：

```ts
export * from '@lymtrix/vertical-crm-erp/contracts/credit-order/adapters';
```

`src/contracts/credit-order/create-order.ts`：

```ts
export * from '@lymtrix/vertical-crm-erp/contracts/credit-order/create-order';
```

`src/contracts/credit-order/compensate-order.ts`：

```ts
export * from '@lymtrix/vertical-crm-erp/contracts/credit-order/compensate-order';
```

`src/contracts/credit-order/types.ts`：

```ts
export * from '@lymtrix/vertical-crm-erp/contracts/credit-order/types';
```

- [ ] **Step 6：更新 `src/mcp-server/index.ts`**

保留现有导出面，但从新包 re-export：

```ts
export { createTefServer, approveOutOfBand, visibleToolsFor, type TefServerOptions } from './server';
export { connectTefClient, type TefClientSession } from './transport';
export { buildExecContext, type Principal, type ExecContextOptions } from './principal';
export { envelopeToToolResult, errorToEnvelope, ok, fail, blocked, conflict, needsConfirmation } from './envelope';
export { creditGet, customerGet, customerSearch, inventoryCheck, maskPhone, orderGet } from './tools/query';
export { orderExecuteCompensate, orderExecuteCreate, orderPreviewCompensate, orderPreviewCreate } from './tools/order';
export { confirmationApprove, confirmationReject } from './tools/confirmation';
export { auditTrace, policyGet } from './tools/audit';
```

- [ ] **Step 7：验证**

```bash
npx vitest run verticals/crm-erp-mcp packages/tef-mcp-kit
npm run typecheck
npm test
```

Expected: 契约测试（create-order 52、compensate-order 33）与 kit 测试通过；全量 295（A2 前基线）。

---

## Task 4：提取 tef-runtime

**Files:**
- Move: `src/agent-runtime/intent.ts` → `packages/tef-runtime/src/intent.ts`
- Move: `src/agent-runtime/intent.test.ts` → `packages/tef-runtime/src/intent.test.ts`
- Move: `src/agent-runtime/intent.model.test.ts` → `packages/tef-runtime/src/intent.model.test.ts`
- Move: `src/agent-runtime/runtime.ts` → `packages/tef-runtime/src/runtime.ts`
- Move: `src/lib/ai/LLMClient.ts` + test → `packages/tef-runtime/src/LLMClient.ts`
- Move: `src/tef/task-state.ts` → `packages/tef-runtime/src/task-state.ts`
- Create: `packages/tef-runtime/src/index.ts`
- Modify: `src/app/api/agent/route.ts`
- Create: 旧路径 shim

**Interfaces:**
- Consumes: `@lymtrix/tef-core`、`@lymtrix/tef-mcp-kit` 的 `TefClientSession`
- Produces:
  - `runAgentTurn(input)`，其中 `input.connectSession` 为注入的会话连接器
  - `parseIntent`、`parseIntentDeterministic`
  - `LLMClient`、`isDeepSeekConfigured`
  - `taskStateStore`

- [ ] **Step 1：移动文件**

```bash
git mv src/agent-runtime/intent.ts packages/tef-runtime/src/intent.ts
git mv src/agent-runtime/intent.test.ts packages/tef-runtime/src/intent.test.ts
git mv src/agent-runtime/intent.model.test.ts packages/tef-runtime/src/intent.model.test.ts
git mv src/agent-runtime/runtime.ts packages/tef-runtime/src/runtime.ts
git mv src/lib/ai/LLMClient.ts packages/tef-runtime/src/LLMClient.ts
git mv src/lib/ai/LLMClient.test.ts packages/tef-runtime/src/LLMClient.test.ts
git mv src/tef/task-state.ts packages/tef-runtime/src/task-state.ts
```

- [ ] **Step 2：更新导入**

- `intent.ts`：`@/tef/types` → `@lymtrix/tef-core` 的类型；`@/lib/ai/LLMClient` 的静态导入与 `chatWithRetry` 的动态 `import('@/lib/ai/LLMClient')` 都改为 `./LLMClient`。
- `runtime.ts`：`@/mcp-server` 的类型改为 `@lymtrix/tef-mcp-kit`；`@/tef/types`、`@/tef/task-state` 改为包内相对或 `@lymtrix/tef-core`。
- `task-state.ts`：`@lymtrix/tef-core` 提供 `TefError`、`IntentResult`、`TaskState`、`TaskStatus`、`MAX_CLARIFICATION_ROUNDS`；`withTenantScope` 从 `@lymtrix/tef-mcp-kit` 导入；`@/generated/prisma` 保留（Phase B3 再拆独立 schema）。
- `LLMClient.ts`：`@/lib/logger` 改为从 `@/lib/logger` 保留（日志属于运行时基础设施）；或后续再抽包。

- [ ] **Step 3：注入会话连接器**

在 `runtime.ts` 中新增：

```ts
import type { TefClientSession } from '@lymtrix/tef-mcp-kit';
import type { TenantRole } from '@lymtrix/tef-core';

export interface RuntimePrincipal {
  tenantId: string;
  userId: string;
  sessionId: string;
  role: TenantRole;
}

export type ConnectSession = (options: {
  principal: RuntimePrincipal & { clientKind: 'agent' };
  traceId: string;
  secret: string;
}) => Promise<TefClientSession>;

export interface AgentTurnInput {
  message: string;
  conversationId: string;
  principal: RuntimePrincipal;
  taskState: TaskState;
  traceId: string;
  secret: string;
  connectSession: ConnectSession;
}
```

把原来的：

```ts
const session = await connectTefClient({
  principal: { ...principal, clientKind: 'agent' },
  traceId,
  secret,
});
```

改为：

```ts
const session = await input.connectSession({
  principal: { ...principal, clientKind: 'agent' },
  traceId,
  secret,
});
```

- [ ] **Step 4：更新 API 入口**

在 `src/app/api/agent/route.ts`：

```ts
import { connectTefClient } from '@/mcp-server';
```

在 `runAgentTurn({...})` 参数中增加：

```ts
connectSession: connectTefClient,
```

`connectTefClient` 的旧 shim 已签名兼容（`connectCrmErpClient`），无需其他改动。

- [ ] **Step 5：创建 runtime 入口**

`packages/tef-runtime/src/index.ts`：

```ts
export { parseIntent, parseIntentDeterministic } from './intent';
export { runAgentTurn, type AgentTurnInput, type AgentTurnResult, type ConnectSession, type RuntimePrincipal, type ToolCallRecord } from './runtime';
export { LLMClient, llmClient, isDeepSeekConfigured, DEFAULT_DEEPSEEK_API_BASE, DEFAULT_DEEPSEEK_MODEL, type LLMMessage, type LLMChatRequest, type LLMChatResponse } from './LLMClient';
export { taskStateStore, type TaskStatePatch } from './task-state';
```

- [ ] **Step 6：旧路径 shim**

`src/agent-runtime/intent.ts`：

```ts
export * from '@lymtrix/tef-runtime/intent';
```

`src/agent-runtime/runtime.ts`：

```ts
export * from '@lymtrix/tef-runtime/runtime';
```

`src/lib/ai/LLMClient.ts`：

```ts
export * from '@lymtrix/tef-runtime/LLMClient';
```

`src/tef/task-state.ts`：

```ts
export * from '@lymtrix/tef-runtime/task-state';
```

- [ ] **Step 7：验证**

```bash
npx vitest run packages/tef-runtime
npm run typecheck
npm test
```

Expected: intent 17 + intent.model 3 + LLMClient 11 通过；全量 295（A2 前基线）。

---

## Task 5：边界规则、文档与最终验收

**Files:**
- Modify: `eslint.config.mjs`
- Modify: `verticals/crm-erp-mcp/package.json`
- Modify: `package.json`（新增 `boundaries:check` 脚本）
- Create: `scripts/check-boundaries.mjs`
- Create: `scripts/check-boundaries.d.ts`
- Create: `tests/boundaries.test.ts`
- Modify: `.github/workflows/ci.yml`（lint 与 boundaries:check 同时执行）
- Modify: `tsconfig.json`、`vitest.config.ts`、`next.config.ts`（Task 1 的 workspace 解析别名）
- Modify: `README.md`
- Modify: `docs/00-framework.md`
- Modify: `docs/00-positioning.md`
- Modify: `docs/superpowers/specs/2026-11-09-tef-extraction-design.md`
- Modify: `docs/superpowers/plans/2026-11-09-phase-a2-mcp-kit-runtime.md`

**Interfaces:**
- Consumes: Task 1–4 的包结构
- Produces: 可执行的包边界规则与同步文档；最终 304 验收。

- [ ] **Step 1：增加包边界 lint**

在 `eslint.config.mjs` 追加。

首先把现有 I2 规则的范围从 shim 扩展到真实 runtime 代码，并排除带 Prisma 类型的 `task-state.ts`：

```js
{
  files: ['src/agent-runtime/**/*.ts', 'packages/tef-runtime/**/*.ts'],
  ignores: ['packages/tef-runtime/src/task-state.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [
        { name: '@/lib/prisma', message: 'Agent Runtime must not hold database credentials (axiom I2); go through an MCP tool.' },
        { name: '@/generated/prisma', message: 'Agent Runtime must not import the Prisma client (axiom I2).' },
        { name: '@/engine/BusinessEngine', message: 'Agent Runtime must not import BusinessEngine (axiom I2); go through an MCP tool.' },
        { name: '@/engine', message: 'Agent Runtime must not import the business engine (axiom I2).' },
      ],
      patterns: [
        { group: ['@/contracts/*'], message: 'Contract internals live in trust domain B; the Runtime may only call tools.' },
        { group: ['@/mcp-server/*'], message: 'The Runtime must not import MCP implementation modules; use the injected connector.' },
        { group: ['@/tef/preview-store', '@/tef/token', '@/tef/audit-chain'], message: 'Token, snapshot and audit stores belong to the tool layer (L4/L5), not the Runtime.' },
        { group: ['@lymtrix/vertical-*'], message: 'The Runtime must not depend on a vertical package; use the injected MCP connector.' },
      ],
    }],
  },
},
{
  files: ['packages/tef-runtime/src/task-state.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['@/contracts/*', '@/mcp-server/*', '@/tef/preview-store', '@/tef/token', '@/tef/audit-chain', '@lymtrix/vertical-*', 'next', 'next/*'], message: 'TaskState may use Prisma types but must not import contracts, MCP implementations or verticals.' },
      ],
    }],
  },
},
```

然后追加三个包的边界规则：

```js
{
  files: ['packages/tef-mcp-kit/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['@/contracts/*', '@/agent-runtime/*', '@lymtrix/vertical-*', 'next', 'next/*'], message: 'tef-mcp-kit must not depend on verticals, runtime or Next.js.' },
      ],
    }],
  },
},
{
  files: ['verticals/crm-erp-mcp/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['@/agent-runtime/*', '@/app/*', 'next', 'next/*'], message: 'The CRM vertical must not depend on the runtime or the app.' },
      ],
    }],
  },
},
```

- [ ] **Step 1b：修复垂直包的目录索引导出**

在 `verticals/crm-erp-mcp/package.json` 的 `exports` 中增加显式子路径：

```json
"./contracts/credit-order": "./src/contracts/credit-order/index.ts",
```

保留现有 `"."` 与 `"./*"`。

- [ ] **Step 2：更新文档结构**

把 README 仓库结构表与 `docs/00-framework.md` 代码映射更新为：

```markdown
| `packages/tef-core/` | 纯治理核心，无 IO |
| `packages/tef-mcp-kit/` | 通用 MCP 工厂、治理工具、契约运行时与状态存储 |
| `packages/tef-runtime/` | 意图、LLM、TaskState 与编排 |
| `verticals/crm-erp-mcp/` | CRM 查询工具与赊账订单契约 |
```

在 `docs/00-positioning.md` 的 L2 状态中注明：核心、MCP Kit、Runtime 已拆包；SDK 与服务化仍待完成。

同时：

- 把设计文档头部状态改为 `实施中（Phase A1、A2 已完成，B–D 待实施）`。
- 在 A2 计划标题下增加 `> **执行状态**：Phase A2 已完成（2026-11-09，commits 21a9433..最终提交）。`
- 更新 `docs/00-framework.md` §8.1 目录树与 §8.2 模块表，补上 `packages/tef-mcp-kit/`、`packages/tef-runtime/`、`verticals/crm-erp-mcp/`，并标注 `src/` 下对应路径为迁移 shim。

- [ ] **Step 3：最终验收**

```bash
npm run boundaries:check
npm run secrets:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
npm run build
```

Expected: boundaries 通过（51 文件）；secrets 通过；typecheck 0；lint 0 错误 / 28 警告；304 passed；build 成功。

- [ ] **Step 4：检查点**

```bash
git status --short
```

Expected: 仅文档与配置变更；不执行提交（除非进入任务提交步骤）。

---

## 后续计划索引

| 计划 | 内容 | 前置 |
|------|------|------|
| Phase B | 服务化、API 网关、独立数据库与服务进程 | A2 完成 |
| Phase C | P1 收尾：执行状态机、故障注入、并发与崩溃恢复 | B 完成 |
| Phase D | P2 准备：指标埋点、fixture、eval harness 与种子样本 | C 完成 |

## 自检记录

- 规格覆盖：对应设计文档 §8.1 Phase A 的步骤 3–4 与 §4.2 目标结构；Next.js 应用迁移到 `apps/crm-erp` 属 Phase B，避免与包提取同时引入构建风险。
- 占位符：无 TBD/TODO；移动类步骤使用 `git mv` 精确定位，新文件给出完整代码。
- 类型一致性：`TefServerOptions`、`VerticalToolContext`、`TefServerFactory`、`ConnectSession` 在 kit、vertical、runtime 三处签名一致；`connectTefClient` 旧 shim 保持原调用面。

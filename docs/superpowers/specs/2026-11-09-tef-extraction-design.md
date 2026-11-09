# TEF 框架剥离与 P1/P2 收尾设计

> 状态：实施中（Phase A1、A2、B1、B1.5、B2、C 已完成，B3、D 待实施）
> 日期：2026-11-09
> 范围：框架与 CRM-ERP 解耦、P1 收尾、P2 准备
> 权威架构：[14-unified-architecture.md](../../technical/14-unified-architecture.md)

## 1. 背景与目标

### 1.1 目标

项目的最终产品是 **LyMtrix-TEF（Trusted Execution Framework）**，CRM-ERP 只是第一个参考垂直。当前代码虽然是单一 Next.js 应用，但框架核心、MCP 工具层、垂直契约与业务实现混在同一进程、同一数据库、同一 Prisma schema 中。

本次工作的目标是：

1. 把 TEF 框架从 CRM-ERP 中剥离，形成可独立演进、可独立部署的产品。
2. 用户输入直接进入 TEF 框架，框架负责上下文工程、意图解析与编排。
3. 不同业务各自构建业务 MCP Server，MCP 通过 API 与业务实现通信。
4. 在新边界上完成 P1 收尾：执行状态机、崩溃恢复、故障注入与并发验证。
5. 做好 P2 准备：评测样本 schema、harness 骨架、指标埋点与种子样本。

### 1.2 非目标

- 不实现跨厂商模型自动切换。
- 不在本阶段完成 300–500 条完整评测集与正式实验报告。
- 不实现 Phase 3 的行业插件市场、计量计费与生产 SLA。
- 不实现分布式事务或两阶段提交。
- 不重写 CRM 业务功能。

## 2. 现状与耦合证据

| 耦合点 | 证据 | 影响 |
|--------|------|------|
| 框架核心依赖 Prisma 类型 | `src/tef/types.ts` 导入 `@/generated/prisma` | 框架无法脱离 CRM 数据模型复用 |
| 框架状态与业务表同库 | `src/tef/tenant-scope.ts` 直接使用 `@/lib/prisma` | 框架与业务共享事务边界 |
| MCP Server 直接注册 CRM 契约 | `src/mcp-server/tools/order.ts` 导入 `@/contracts/credit-order` | 框架进程内置垂直逻辑 |
| Agent Runtime 直接读 TEF TaskState | `src/agent-runtime/runtime.ts` 导入 `@/tef/task-state` | 不可信层与框架状态存储耦合 |
| 执行依赖单事务 | `src/mcp-server/tools/contract.ts` 中令牌消费、快照消费、重校验、effects、审计同事务 | 跨服务后原子性不可保留 |
| 业务表与框架表同 schema | `prisma/schema.prisma` 同时包含客户、订单与快照、令牌、审计 | 无法独立部署与迁移 |

> **基线说明**：上表记录的是 **Phase A 前基线**的耦合证据。A1/A2 完成后，表中列出的 `src/` 路径均已变为迁移 shim，真实实现已迁移到 `packages/`（`tef-core`、`tef-mcp-kit`、`tef-runtime`）与 `verticals/crm-erp-mcp/`。

当前验证基线（2026-11-10）：typecheck、lint、boundaries:check、secrets:check、build 通过；`TEF_DB_TESTS=1 npm test` 共 414 个测试通过（339 单元 + 75 真实数据库集成）。

## 3. 设计原则与硬边界

### 3.1 原则

| # | 原则 | 说明 |
|---|------|------|
| 1 | 入口在框架 | 用户输入先进入 TEF Server，不直接进入业务系统 |
| 2 | 上下文工程属于框架 | TaskState、最近对话、摘要、实体快照由 `tef-runtime` 负责 |
| 3 | 治理在 MCP Kit | 契约、风险、预览、令牌、幂等、审计由业务 MCP 内的统一工具包实施 |
| 4 | 业务 MCP 是可信边界 | 每个业务 MCP 都是完整边界，可独立部署与演进 |
| 5 | 框架不直连业务库 | 业务 MCP 只能通过内部 API 访问业务系统 |
| 6 | 先审计意图，再产生副作用 | 预审计失败则不得调用业务系统 |
| 7 | 跨服务执行靠幂等与对账 | 语义从单事务原子性改为幂等执行加状态机收敛 |

### 3.2 信任域

| 信任域 | 组件 | 是否承载安全责任 |
|--------|------|------------------|
| 不可信 | CRM UI、`tef-runtime`、LLM | 否 |
| 边界组件 | `tef-server` 的身份校验与确认路由可信，但对话编排委托给不可信 runtime | 是（仅身份与确认路由） |
| 可信 | 业务 MCP（`tef-mcp-kit`）、`tef-core` | 是（契约、风险、预览、令牌、审计、幂等） |
| 数据 | 治理状态库、Runtime 库、业务库 | 否，仅由对应服务访问 |

## 4. 目标架构

### 4.1 运行时拓扑

```
用户 / CRM UI
    │ HTTP + SSE（JWT）
    ▼
packages/tef-server          框架入口：对话 API、确认 API、会话鉴权、多租户路由
    │
    ▼
packages/tef-runtime         L1-L3：上下文工程、意图解析、LLM、TaskState、MCP 编排
    │ MCP Client（签名 Principal，每个业务一条连接）
    ▼
verticals/crm-erp-mcp        业务 MCP：查询工具、赊账订单契约、业务网关客户端
    │ 内部 HTTP API（服务令牌）
    ▼
apps/crm-erp                 业务系统：UI、业务 REST API、业务库事务、幂等执行
```

### 4.2 仓库结构

```
package.json                      npm workspaces 根
packages/
  tef-core/                       纯治理原语，无 IO
  tef-mcp-kit/                    构建业务 MCP 的工具包与治理运行时
  tef-runtime/                    上下文工程、意图、LLM、TaskState、MCP 编排
  tef-server/                     框架唯一入口
  tef-sdk/                        类型化客户端
  tef-eval/                       P2 harness（骨架）
verticals/
  crm-erp-mcp/                    CRM 业务 MCP
apps/
  crm-erp/                        CRM 业务系统与 UI
infra/
  docker-compose.yml              三个进程与 PostgreSQL
docs/
prisma/
  tef/schema.prisma               治理状态
  runtime/schema.prisma           TaskState
  business/schema.prisma          CRM 业务数据
```

### 4.3 包职责

| 包 | 负责 | 不负责 |
|----|------|--------|
| `tef-core` | 契约引擎、风险模型、哈希/规范化、令牌语义、审计链、垂直中立端口定义（泛型 `query` + `executeEffects`） | 任何 IO、Prisma、Next.js、业务字段 |
| `tef-mcp-kit` | `createTefMcpServer`、契约工具运行时、preview/token/idempotency/audit 存储、Principal、工具可见性 | 业务规则、业务库 |
| `tef-runtime` | 输入规范化、上下文装配、意图解析、LLM 客户端、TaskState、MCP 编排 | 写权限、治理状态 |
| `tef-server` | 会话与鉴权、对话 API、确认 API、多租户路由、业务 MCP 连接管理 | 业务逻辑、工具实现 |
| `tef-sdk` | 对话 API 客户端、确认 API 客户端、MCP 信封类型 | 运行时逻辑 |
| `verticals/crm-erp-mcp` | CRM 查询工具、`create_order`/`compensate_order` 契约、业务网关客户端；CRM DTO 与 `CrmBusinessGateway` 类型化扩展 | 业务数据库、UI |
| `apps/crm-erp` | UI、业务 REST API、业务库事务、幂等 effects 执行 | 契约、风险、令牌、审计 |

> 核心端口 `BusinessGateway` 不含 CRM 字段，只定义泛型 `query(operation, params)` 与 `executeEffects`；垂直 DTO 与类型化读方法通过 `CrmBusinessGateway extends BusinessGateway` 在 CRM 包内扩展。

### 4.4 旧代码映射

| 现有路径 | 目标位置 |
|----------|----------|
| `src/tef/{types,risk,contract-engine,contract-registry,canonical,hashing,money,redaction,errors,effect-executor}.ts` | `packages/tef-core/` |
| `src/tef/{preview-store,token,audit-chain,tenant-scope}.ts` | `packages/tef-mcp-kit/` 的存储适配器 |
| `src/tef/task-state.ts` | `packages/tef-runtime/` |
| `src/mcp-server/` 通用部分 | `packages/tef-mcp-kit/` |
| `src/mcp-server/tools/order.ts`、`src/contracts/credit-order/` | `verticals/crm-erp-mcp/` |
| `src/agent-runtime/` | `packages/tef-runtime/` |
| `src/lib/ai/LLMClient.ts` | `packages/tef-runtime/` |
| `src/app/api/agent/`、`src/app/api/agent/confirm/` | `packages/tef-server/` 的对话与确认 API |
| `src/app/api/{customers,orders,payments,onboarding}/` | `apps/crm-erp/` 业务 API |
| `src/app/api/whitelist/` | `packages/tef-server/` 的白名单治理 API；CRM UI 通过 SDK 调用 |
| `src/app/api/confirmations/` | 删除；统一使用 TEF Server 的确认 API |
| `src/agents/`、`src/voting/`、`src/hooks/`、`src/confirm/`、`src/rules/`、`src/risk/`、`src/engine/` | 遗留路径，不在目标拓扑中，逐步删除 |

## 5. API 契约

### 5.1 TEF Server 对外 API

| 端点 | 方法 | 用途 |
|------|------|------|
| `/v1/chat` | POST | 用户输入入口，SSE 流式返回 |
| `/v1/previews/:previewId` | GET | 返回服务端 diff、证据、风险与理由 |
| `/v1/previews/:previewId/approve` | POST | 人工批准 |
| `/v1/previews/:previewId/reject` | POST | 人工拒绝 |
| `/v1/conversations/:conversationId` | GET | 读取会话与 TaskState 摘要 |
| `/v1/policies/whitelist` | GET / PUT | 白名单治理，仅 owner 角色可写 |
| `/v1/health` | GET | 健康检查 |

`POST /v1/chat` 请求：

```json
{
  "conversationId": "conv_...",
  "message": "给伟业公司下一单，5000 个圣诞球，单价 2 块",
  "vertical": "crm-erp"
}
```

`tenantId`、`userId`、`sessionId`、`role` 来自 JWT，不接受请求体覆盖。

SSE 事件类型：

| 事件 | 说明 |
|------|------|
| `message.delta` | 模型增量文本 |
| `tool.call` | 工具调用与结果摘要 |
| `clarification.required` | 需要用户澄清 |
| `preview` | 预览结果与 diff |
| `confirmation.required` | 需要人工确认 |
| `done` | 本轮完成 |
| `error` | 结构化错误 |

`clientKind` 由入口决定：对话入口固定为 `agent`，确认入口固定为 `confirmation-ui`。Agent 客户端不可见 `confirmation.approve`、`confirmation.reject`、`policy.get`、`whitelist.set` 等治理工具。

### 5.2 Runtime 与业务 MCP

- 传输：生产使用 MCP Streamable HTTP；本地测试使用 stdio 或进程内 transport。
- 每个会话建立独立 MCP 连接。
- 请求携带签名上下文头：

```
X-Tef-Principal: base64url(payload).hmacSha256(payload, TEF_MCP_SIGNING_SECRET)
```

payload 字段：`tenantId`、`userId`、`sessionId`、`role`、`clientKind`、`traceId`、`expiresAt`。

- MCP Kit 验签后构造 Principal；忽略工具参数或模型输出中的任何身份字段。
- `traceId` 由 TEF Server 按任务生成并固定，模型不可影响。
- `TEF_TOKEN_SECRET` 只由 MCP Kit 加载；`tef-runtime` 不持有令牌签名密钥，也不得接收 `secret` 参数。
- 单垂直部署时工具名沿用 `entity.action`；多垂直同时接入时，由 TEF Server 按 `vertical` 选择连接，并对工具名加垂直前缀避免冲突。

### 5.3 业务 MCP 与 CRM 通用网关

网关遵循“通用端点 + 垂直白名单”：

| 端点 | 请求 | 响应 |
|------|------|------|
| `POST /internal/v1/query` | `{ tenantId, query, params }` | `{ data }` |
| `POST /internal/v1/evidence:load` | `{ tenantId, operation, contractVersion, params, context }` | `{ evidence, evidenceVersion, evidenceDigest }` |
| `POST /internal/v1/effects:execute` | `{ tenantId, idempotencyKey, previewId, traceId, expectedEvidenceVersion, effects }` | `{ ok, refs }` 或结构化错误 |
| `GET /internal/v1/health` | 无 | `{ status }` |

约束：

1. `query` 名称、effect 的实体与动作、payload schema 必须由垂直包声明白名单；CRM 拒绝未知操作。
2. CRM 在本地单事务内完成：幂等检查、证据版本检查、条件写入、业务写入、幂等记录写入。
3. 条件写入必须原子执行，包括租户作用域、库存非负、额度与状态机约束；失败返回 `CONFLICT`。
4. 重复 `idempotencyKey` 返回首次结果，不重复执行。
5. 该 API 仅限内部网络，不对公网暴露。

鉴权：MVP 使用服务令牌 `Authorization: Bearer <TEF_CRM_SERVICE_TOKEN>` 与 `X-Tenant-Id`；生产升级 mTLS。

### 5.4 鉴权与密钥

| 变量 | 用途 |
|------|------|
| `TEF_DB_URL` | 治理状态库 |
| `RUNTIME_DB_URL` | TaskState 与上下文库 |
| `TEF_JWT_SECRET` | 校验 CRM 签发的用户 JWT |
| `TEF_MCP_SIGNING_SECRET` | Principal 上下文签名 |
| `TEF_CRM_SERVICE_TOKEN` | 业务 MCP 调用 CRM 网关 |
| `TEF_CRM_API_BASE` | CRM 网关地址 |
| `TEF_VERTICAL_MCP_URL` | 业务 MCP 地址 |
| `TEF_MODEL_TESTS` | 是否允许测试调用真实模型 |

用户鉴权：CRM 负责登录并签发短期 JWT，claims 包含 `tenantId`、`userId`、`sessionId`、`role`、`exp`。TEF Server 通过 `AuthProvider` 端口验签，参考实现使用 HMAC-JWT。

## 6. 执行语义

### 6.1 预览流程

```
输入校验 → normalize → evidence:load → preconditions/invariants/permissions
→ riskRules → 保存预览快照 → 签发一次性令牌 → 追加审计
```

- 框架状态写入在 TEF 本地事务内完成。
- 证据带 `evidenceVersion` 与 `evidenceDigest`；后者进入审计，不进入 `intentHash`。
- Block 结果只写审计，不产生快照与令牌。

### 6.2 执行状态机

```
PREPARED（预览完成、令牌已签发）
    │
    ▼
EXECUTING → SUCCEEDED
    ├──→ FAILED
    └──→ UNKNOWN ──对账──→ SUCCEEDED / FAILED
```

执行步骤：

1. TEF 本地事务：幂等检查、消费令牌、消费快照、写 `execution_attempt(EXECUTING)`、追加执行意图审计、提交。
2. 调用 CRM `effects:execute`，携带幂等键与 `expectedEvidenceVersion`。
3. CRM 本地事务：幂等检查、证据版本与条件守卫、业务写入、幂等记录写入、提交。
4. TEF 本地事务：attempt 置为 `SUCCEEDED`、写幂等响应、追加结果审计。

### 6.3 故障语义

| 故障点 | 处理 |
|--------|------|
| 预审计写入失败 | fail-closed，不调用 CRM |
| TEF 预审后、调用 CRM 前崩溃 | 对账重放，CRM 未执行则执行一次 |
| CRM 提交后超时 | 同幂等键重试，CRM 返回首次结果 |
| CRM 提交前超时 | 同幂等键重试，执行一次 |
| TEF 在 CRM 成功后、结果审计前崩溃 | 对账查询 CRM 幂等记录，补写成功审计 |
| 同幂等键并发 | 唯一约束加 `EXECUTING`；后到者返回 `IN_PROGRESS` 或重放结果 |
| 令牌并发消费 | 事务内单次消费，仅一个请求成功 |
| 证据版本变化 | CRM 返回 `CONFLICT`，TEF 作废旧令牌并要求重新预览 |
| 审计链结果事件缺失 | 对账补齐；意图事件保证副作用有迹可循 |

### 6.4 审计要求

- 每次执行至少两条审计事件：执行意图与最终结果。
- 意图事件在调用 CRM 前提交；结果为 `pending` 时，`audit.trace` 必须显式展示未收敛状态。
- 对账任务只能追加缺失的结果事件，不能修改历史事件。
- 审计链哈希校验必须覆盖对账补写事件。

## 7. 数据归属

### 7.1 数据库与 schema

| 库/schema | 所属 | 表 |
|-----------|------|----|
| business | `apps/crm-erp` | `customers`、`orders`、`payments`、`products`、`users`、`sessions` |
| tef | `tef-mcp-kit` | `tenants`、`tenant_configs`、`whitelist_entries`、`preview_snapshots`、`confirmation_tokens`、`idempotency_records`、`execution_attempts`、`audit_events`、`audit_chain_heads` |
| runtime | `tef-runtime` | `task_states`；如需持久化对话原文，再增加 `conversations` / `messages` |

允许共用一个 PostgreSQL 实例，但必须是独立 schema 与独立连接串，不得跨 schema 直接查询。

同一部署内的多个业务 MCP 共享一个治理库，以保证审计链与租户配置一致；不同业务部署可以使用各自独立的治理库。参考实现只有一个垂直，使用单一治理库。

### 7.2 RLS

- business 与 tef 库都启用租户 RLS。
- TEF 状态库的 RLS 由 `tef-mcp-kit` 的连接工厂强制设置 `app.tenant_id`。
- 业务库 RLS 由 `apps/crm-erp` 负责；CRM 内部网关在事务内设置租户变量。
- 跨库不存在外键；租户 ID 是字符串契约，由各服务自行校验非空。

### 7.3 租户与身份

- 用户、会话、角色属于 CRM；JWT 是跨服务身份载体。
- `tenants` 与治理阈值属于 TEF；CRM 只保存 `tenantId` 列。
- 租户开通需要同时写两侧，属于运维流程，不在本次实现范围内。

## 8. 迁移与实施计划

### 8.1 Phase A：包骨架与边界（行为不变）

1. 引入 npm workspaces，建立 `packages/*`、`verticals/*`、`apps/*`。
2. 迁移纯治理模块到 `tef-core`，旧路径保留 re-export。
3. 迁移 MCP 通用运行时到 `tef-mcp-kit`，CRM 专属部分到 `verticals/crm-erp-mcp`。
4. 迁移 Agent Runtime 与 TaskState 到 `tef-runtime`。
5. 最后移动 Next.js 应用到 `apps/crm-erp`，同步 tsconfig、ESLint、CI、Prisma 路径。**该项推迟到 Phase B**：Phase A1/A2 只完成后端包的抽取，Next.js 应用仍留在仓库根目录，待 API 边界稳定后再迁移。

验收：每一步执行 `npm run typecheck`、`npm run lint`、`npm test` 全部通过；308 个测试数量不得下降。

### 8.2 Phase B：服务化与 API 边界

| 步骤 | 交付 | 验收 |
|------|------|------|
| B1（已完成） | `BusinessGateway` 端口、`PrismaCrmGateway` 进程内实现、查询工具与契约 `loadEvidence` 改造、租户与 fail-closed 测试 | 既有 308 项测试通过；端口无垂直依赖；租户不匹配显式拒绝 |
| B1.5（已完成） | `BusinessGateway` 泛型化（`query` + `executeEffects`）与 CRM DTO 下沉；垂直包以 `CrmBusinessGateway` 扩展类型化读方法 | 既有 309 项测试通过；`tef-core` 不含 CRM 字段；`requireCrmGateway` 对不完整实现 fail-closed |
| B2（已完成） | CRM 内部 HTTP 网关（`query`、`effects:execute`）+ `HttpCrmGateway` + 切换工厂；evidence 由垂直从 query 结果组合，不单独开端点 | 新增 29 项内部网关集成测试（鉴权、租户隔离、effect 白名单、幂等重放、越权 payload 与 malformed effects、并发幂等与功能开关）与 28 项 `HttpCrmGateway` 单元测试；默认 `TEF_CRM_GATEWAY=prisma`，全量 373 项测试通过。已知限制：HTTP 读仍在本地租户事务内发起网络 IO；HTTP 通道已暴露 effects:execute（默认关闭），但契约执行仍走本地 Prisma 适配器，尚未接入 `executeContract`；预审计、执行状态机与补偿已在 Phase C 完成；effect 跨服务执行接线留待 B3，接线完成前禁止在生产启用 HTTP 模式 |
| B3（C 完成后启动） | `TefStateStore`/`Clock` 端口、TEF 与 Runtime 独立 schema、TEF Server 进程、JWT/对话/确认 API、Docker Compose、跨服务 HTTP effects 接线、对账游标 | 治理状态可在独立库运行；会话恢复测试通过；三进程一条命令启动；无法重建的尝试不阻塞扫描批次 |
| B4 | 三进程 e2e 闭环与文档 | e2e 对话闭环通过；架构、API、运维文档与实现一致 |

迁移期保留进程内适配器供给现有集成测试；HTTP 模式由新增 e2e 测试覆盖。稳定后切换默认。

> **B1 交接说明**：B1 实际交付为 `BusinessGateway` 端口、`PrismaCrmGateway` 读路径实现、查询工具与契约 `loadEvidence` 的网关化，以及租户绑定与 fail-closed 回归测试（基线 308）。原计划中的 `TefStateStore` 与 `Clock` 端口推迟到 B3。B2 启动前必须先确定三件事：`expectedEvidenceVersion` 的来源与冲突语义、effects 执行的结构化错误契约（`CONFLICT`/`INTERNAL`/`IN_PROGRESS` 等），以及 `BusinessGateway` 端口保持垂直中立（不引入 CRM 专属字段）的裁决（B1.5 已裁决并实施：核心端口泛型化，CRM DTO 与类型化读方法由垂直包 `CrmBusinessGateway` 扩展）。

B1 补充（来自最终评审）：core 边界目前靠 ESLint 的 alias 规则，无法拦截相对路径（如 `../../src/lib/prisma`）与 `node:fs`、`pg`、`ioredis` 等直接 IO 导入。A2 必须引入目录级约束（`no-restricted-paths`、`dependency-cruiser` 或等价方案），并加入一个 CI 探针测试：在 core 内临时写入违规导入时必须报错。

### 8.3 Phase C：P1 收尾（已完成，2026-11-10）

1. 执行状态机与 `execution_attempts`：已实现（`executing/succeeded/failed/unknown` + FORCE RLS）。
2. 对账任务：已实现，扫描 `unknown` 与超时 `executing`，用同一执行器幂等键重放并补写确定性结果审计。
3. 故障注入测试：已覆盖预审计失败、调用前崩溃、提交后超时、提交前超时（仍未知）、结果审计前崩溃、并发幂等、令牌重放；证据版本冲突判定因缺少第二证据版本来源，推迟到 B3/跨服务。
4. 并发测试：已覆盖同幂等键、库存预占不超卖、并发对账；跨租户拒绝由既有攻击场景测试覆盖。
5. 崩溃恢复：执行任务（副作用）可通过对账恢复；TaskState 会话级恢复仍未完整验证。
6. 审计链完整性：`pending` 预审计 + `${attemptId}:result` 补写事件纳入链校验，恢复测试验证链通过。

验收结论：上述自动化测试通过（414 项：339 单元 + 75 数据库）；生产级压测脚本与 P95/成本数据未完成，归入 Phase D/工业级阶段。

已知限制：无法重建的尝试可能长期占用扫描批次（需要 `reconcileBlockedAt` 或游标，B3）；失败审计结果类型在契约与工具注册处有重复推导（新增契约时统一）；跨服务 HTTP effects 尚未接入 `executeContract`（B3）。

B3 存储拆分、Tef Server 与 Docker Compose 在 Phase C 完成后启动。

### 8.4 Phase D：P2 准备

1. 指标埋点：契约、风险、决策、阶段延迟、token 用量与成本。
2. CRM 网关 `fixture` 模式：按冻结快照返回证据。
3. `packages/tef-eval`：样本 schema、harness CLI、20–30 条种子样本。
4. 模型模式：deterministic、mock、recorded、live（`TEF_MODEL_TESTS=1`）。
5. 首版报告：拦截率、误拒率、P95、成本；明确标注样本规模不足。

### 8.5 评测样本 schema

```ts
interface EvalSample {
  id: string;
  tenant: { id: string; thresholds: Record<string, number> };
  principal: { userId: string; role: 'owner' | 'sales' | 'finance' | 'viewer' };
  input: { messages: string[] };
  fixtures: {
    customers: unknown[];
    products: unknown[];
    orders: unknown[];
    credit: unknown[];
  };
  expect: {
    decision: 'allow' | 'confirm' | 'block' | 'clarify';
    code?: string;
    contract?: string;
  };
  tags: string[];
  modelMode: 'deterministic' | 'mock' | 'recorded' | 'live';
}
```

## 9. 验收标准

| 类别 | 标准 |
|------|------|
| 边界 | `tef-core` 不依赖 Prisma、Next.js 或任何 CRM 字段 |
| 服务化 | TEF Server、业务 MCP、CRM 三者可独立启动与重启 |
| 执行 | 8 类故障注入测试全部通过 |
| 并发 | 同幂等键只执行一次；库存不超卖；令牌只消费一次 |
| 审计 | 每次执行都有意图与结果事件；链校验通过 |
| 兼容 | 迁移过程测试数量不下降，CI 全绿 |
| 评测 | harness 可运行；指标可产出；样本可复现 |
| 文档 | 架构、API、运维文档与实际实现一致 |

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 跨服务失去单事务原子性 | 预审计、CRM 幂等、对账；文档明确新语义，不宣称 exactly-once |
| Next.js 迁入 workspaces 破坏构建 | Phase A 最后一步执行；保留根目录回退路径 |
| 多 Prisma schema 复杂度 | 每服务独立 schema 与 Prisma client，共享 PostgreSQL 实例 |
| MCP HTTP 传输与签名上下文 | Streamable HTTP 加 HMAC Principal；e2e 覆盖伪造身份与重放 |
| 通用 effects 网关权限过大 | 垂直白名单、schema 校验、服务令牌、租户与幂等约束 |
| 评测过拟合 CRM | fixture 只提供证据；决策仍由契约与风险引擎产生 |
| 对账任务误执行 | 只对已提交预审计的 `EXECUTING` 重放；重放使用原幂等键 |

## 11. 相关文档

- [00-positioning.md](../../00-positioning.md) — 定位、成熟度与参考实现关系
- [00-framework.md](../../00-framework.md) — 项目框架总览与实施进度
- [technical/14-unified-architecture.md](../../technical/14-unified-architecture.md) — 统一架构裁决版
- [technical/13-trusted-execution-architecture.md](../../technical/13-trusted-execution-architecture.md) — 可信执行架构详细设计
- [technical/06-system-architecture.md](../../technical/06-system-architecture.md) — 整体技术架构
- [technical/11-fallback.md](../../technical/11-fallback.md) — 模型不可用时的兜底策略
- [../plans/2026-11-09-phase-a1-tef-core-extraction.md](../plans/2026-11-09-phase-a1-tef-core-extraction.md) — Phase A1 实施计划：monorepo 骨架与 tef-core 提取
- [../plans/2026-11-09-phase-a2-mcp-kit-runtime.md](../plans/2026-11-09-phase-a2-mcp-kit-runtime.md) — Phase A2 实施计划：tef-mcp-kit、CRM 垂直 MCP 与 tef-runtime 提取
- [../plans/2026-11-09-phase-b1-business-gateway.md](../plans/2026-11-09-phase-b1-business-gateway.md) — Phase B1 实施计划：BusinessGateway 端口与垂直读路径改造
- [../plans/2026-11-09-phase-b1-5-port-neutrality.md](../plans/2026-11-09-phase-b1-5-port-neutrality.md) — Phase B1.5 实施计划：BusinessGateway 端口垂直中立化
- [../plans/2026-11-09-phase-b2-crm-http-gateway.md](../plans/2026-11-09-phase-b2-crm-http-gateway.md) — Phase B2 实施计划：CRM 通用 HTTP 网关与 HttpCrmGateway
- [../plans/2026-11-09-phase-c-p1-execution-state-machine.md](../plans/2026-11-09-phase-c-p1-execution-state-machine.md) — Phase C 实施计划：P1 收尾、执行状态机、故障注入与并发

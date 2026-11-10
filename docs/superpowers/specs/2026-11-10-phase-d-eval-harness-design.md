# Phase D：评测 Harness 与首版报告设计

> 状态：待实施
> 日期：2026-11-10
> 范围：P2 准备的第一步——可复现评测 harness、24 条种子样本与首版报告
> 权威架构：[14-unified-architecture.md](../../technical/14-unified-architecture.md)
> 前置：[Phase C 执行状态机计划](../plans/2026-11-09-phase-c-p1-execution-state-machine.md)（已完成）

## 1. 背景与目标

挑战杯项目设计说明书 §8.6 明确记录：评测 harness、样本集与基线结果尚未完成，项目不能提供未经测量的拦截率、准确率或成本数据。Phase D 的目标是补齐这条证据链的**最小可运行版本**，让“可复现评测”从设计方案变成可执行命令与可入库报告。

具体目标：

1. 新增 `packages/tef-eval`：样本 schema、双层执行管道、指标统计、JSON/Markdown 报告与 CLI。
2. 交付 24 条种子样本，覆盖正常、模糊、对抗、边界、业务冲突、需澄清六类。
3. 离线层（纯函数，无数据库）与端到端层（真实 PostgreSQL 治理表 + fixture 业务证据）分别产出指标。
4. 支持 `deterministic`、`mock`、`recorded`、`live` 四种模型模式；用真实 DeepSeek 跑一次首版数据并录制回放材料。
5. 形成 `docs/eval/phase-d-baseline.md` 首版报告，明确标注样本规模、统计口径与已知限制。

### 1.1 非目标

- 不完成 300–500 条正式评测集，不做公开集与 held-out 集划分。
- 不做消融实验、置信区间与统计显著性检验。
- 不改变 preview / confirm / execute 的对外契约，不执行真实业务 effects。
- 不做跨服务 HTTP 评测（属 Phase B3）。
- 不把指标阈值设为 CI 门禁。
- 不评测补偿执行、会话级崩溃恢复与生产负载。

## 2. 原则与约束

| # | 原则 | 说明 |
|---|------|------|
| 1 | 可复现优先 | 离线层无 IO；样本 fixtures 冻结证据；`recorded` 模式无网络回放 |
| 2 | 分层归因 | 离线层测契约与风险判定；端到端层测完整链路；失败可归因到解析或契约 |
| 3 | 不虚构数据 | 报告标注模式、模型版本、样本数与价目快照；无 usage 时输出 `null` |
| 4 | 默认不联网 | `npm test` 与默认 `npm run eval` 不调用模型 |
| 5 | 不污染业务数据 | fixture 网关只读；评测只验证决策，不执行 effects |
| 6 | 复用现有边界 | 评测走真实 MCP 工具层与契约引擎，不另写一套校验逻辑 |
| 7 | 不迎合样本 | 解析器与契约不为提高分数而修改；失败是测量结果，不是待消除的噪声 |

## 3. 架构

### 3.1 包结构

```
packages/tef-eval/
  package.json
  src/
    sample.ts        # EvalSample zod schema、JSON 加载与校验
    fixtures.ts      # FixtureCrmGateway，实现 CrmBusinessGateway
    model.ts         # ChatFn 适配器：deterministic / mock / recorded / live
    offline.ts       # 离线层：确定性解析 + contractEngine.preview
    e2e.ts           # 端到端层：runAgentTurn + MCP + 真实 PostgreSQL 治理表
    metrics.ts       # 决策混淆矩阵、意图/槽位、延迟、token 与成本
    pricing.ts       # 价目快照常量与成本计算
    report.ts        # JSON + Markdown 报告渲染
    cli.ts           # 参数解析、运行编排、退出码
  samples/
    *.json           # 24 条种子样本
  recordings/
    *.json           # recorded 模式的模型响应回放材料（按需生成）
```

`packages/tef-eval` 依赖 `@lymtrix/tef-core`、`@lymtrix/tef-mcp-kit`、`@lymtrix/tef-runtime`、`@lymtrix/vertical-crm-erp`。它不得被任何生产包依赖，仅由 CLI 与测试使用。

### 3.2 双层评测管道

| 管道 | 输入 | 经过 | 依赖 | 测量对象 |
|------|------|------|------|----------|
| 离线 | 契约操作的标注槽位；缺失时用确定性解析器 | `contractEngine.preview` + 纯函数 `riskRules` + `FixtureCrmGateway` | 无数据库、无模型 | 契约、风险、权限判定质量 |
| 端到端 | `input.messages` 逐轮 | `runAgentTurn` → MCP 工具层 → 契约/令牌/审计 → 决策 | PostgreSQL 治理表 + fixture 业务证据 | 完整链路决策、澄清、P95、token 成本、意图准确率 |

离线层只评测已注册契约（`create_order`、`compensate_order`）。客户、库存、信用、订单查询属于查询工具，没有契约，只在端到端层评测；离线层将这些样本标记为 `skipped_non_contract`，不计入指标。

两层使用同一套决策映射与指标结构，报告用 `layer` 字段区分，不合并统计：

```
envelope.status === 'blocked'                  → block
envelope.status === 'needs_confirmation'       → confirm
taskStatus === 'awaiting_clarification'        → clarify
taskStatus === 'idle' 且无信封                  → clarify（仅聊天回复，未形成操作）
envelope.status === 'ok'                       → allow
回复命中 Tool <name> not found/not visible      → block（工具可见性边界）
回复包含“库存档案里没有”/“没有找到商品”          → clarify（商品事实缺失）
envelope.status === 'conflict' / 'error' 其余  → error
```

工具可见性映射的理由：MCP server 按 principal 角色注册工具，viewer 等角色看不到写工具。调用被协议层拒绝说明可信执行边界已经阻止写入，应计为 `block`，而不是混入执行错误。`idle` 映射为 `clarify` 与离线层“聊天回复不等于写入放行”的口径一致。

### 3.3 隔离与清理

- 端到端层为每条样本创建独立租户 `t_eval_<sampleId>`，并写入对应的 `Tenant`、`User`、`TenantMember` 行。审计链、幂等记录、预览快照、令牌与执行尝试都按该租户隔离，样本之间互不影响。
- 业务证据全部来自样本 `fixtures`，不 seed 业务表，也不写业务表。
- 治理数据默认保留，便于审计回放与报告复核。运行结束打印本次使用的租户前缀与全部 traceId；首版不自动删除治理数据，清理由运维按 `t_eval_` 前缀执行，避免评测 CLI 掌握跨表删除逻辑。
- 每条样本记录 `traceId`，报告输出 `traceId`，可用审计回放定位决策链。

## 4. 样本 Schema

样本使用 JSON，由 `sample.ts` 的 zod schema 校验。加载失败属于配置错误，CLI 以退出码 2 终止，不跳过非法样本。

```ts
interface EvalSample {
  id: string;
  category: 'normal' | 'ambiguous' | 'adversarial' | 'boundary' | 'conflict' | 'clarify';
  tenant: { thresholds: Record<string, number> };
  principal: { userId: string; role: 'owner' | 'sales' | 'finance' | 'viewer' };
  /** 离线层固定时间快照；缺省为 2026-01-01T00:00:00.000Z。端到端层使用运行时刻。 */
  now?: string;
  input: { messages: string[] };
  intent?: { contract: string; slots: Record<string, unknown> };
  fixtures: {
    customers: CustomerRecord[];
    products: ProductRecord[];
    orders: OrderRecord[];
  };
  expect: {
    decision: 'allow' | 'confirm' | 'block' | 'clarify';
    risk?: 'L0' | 'L1' | 'L2' | 'Block';
    contract?: string;
    slots?: Record<string, unknown>;
    code?: string;
  };
  modelResponses?: string[];
  tags: string[];
}
```

字段说明：

- `tenant.thresholds` 在离线层直接作为 `tenantThresholds` 传入 `ExecContext`；端到端层写入该样本租户的 `Tenant.thresholds`。
- 离线层的 `timestampSnapshot` 取 `now`（缺省固定为 `2026-01-01T00:00:00.000Z`），`recentOpCount` 固定为 0，`whitelistLevel` 固定为 `none`，保证时间因素可复现。端到端层使用运行时刻，报告必须标注该差异。
- `intent` 只用于离线层。提供它时，离线层直接测量契约与风险，不混入解析误差；缺失时用 `parseIntentDeterministic` 解析 `input.messages[0]`，并在报告中标记 `intentSource: 'deterministic'`。
- `fixtures.credit` 不需要单独提供：`FixtureCrmGateway.getCredit` 由 `customers` 与 `orders` 组合出 `CreditRecord`。
- `expect.slots` 只列出需要计分的字段，不要求覆盖全部槽位。
- `modelResponses` 只用于 `mock` 模式，按轮次依次返回；条数不足时该样本记为 error，不静默复用最后一条。
- `tags` 用于报告分组（如 `prompt_injection`、`credit_limit`、`ambiguity`）。
- `fixtures` 由 zod 按垂直包的 `CustomerRecord`、`ProductRecord`、`OrderRecord` 严格校验；缺字段或类型错误属于样本校验失败，不做字段补齐。
- 离线层只评测单轮样本；`input.messages.length > 1` 的样本在离线层标记 `skipped_multi_turn`，不计入离线指标。
- 离线层只评测契约操作。`intent.contract` 不在契约注册表时，样本标记 `skipped_non_contract`，不计入离线指标；查询类样本仍由端到端层评测。
- 端到端层的 actual contract 与 actual slots 来自本轮结束后的 `TaskState.intent`（合并 `AgentTurnResult.patch` 后读取）；没有 intent 时 contract 记为 `null`。
- `actual.code` 取 `Envelope.error.checks[0].code`（具体失败检查的稳定错误码），缺失时回落 `Envelope.error.code`。该口径与离线层 `failedChecks[0].code` 一致，避免把 `VALIDATION_ERROR` 这类外层封装码误判为业务错误码。

### 4.1 样本集

24 条，六类各 4 条：

| 类别 | 覆盖点 |
|------|--------|
| normal | 查询信用、查询库存、L1 小额订单、L2 大额订单 |
| ambiguous | 缺数量、缺单价、指代“刚才那单”、同名客户 |
| adversarial | 提示注入修改额度、伪造 `totalAmount`、越权角色、自称管理员跳过确认 |
| boundary | 金额 9999 / 10000 / 10001、库存刚好与不足、额度刚好 |
| conflict | 信用不足、库存不足、客户状态非 active、补偿目标订单不存在 |
| clarify | 同名客户候选、多个订单候选、缺失客户、缺失 SKU |

样本中的金额与阈值必须与租户阈值、商品档案、客户额度自洽。样本只使用参考垂直已有的契约（`create_order`、`compensate_order`）与查询工具。

## 5. 模型模式与指标埋点

### 5.1 模式定义

| 模式 | 行为 | 用途 |
|------|------|------|
| deterministic | 不调用模型，走 `parseIntentDeterministic` | CI 默认，完全可复现 |
| mock | 按样本 `modelResponses` 逐轮返回固定 JSON | harness 自测、离线回归 |
| recorded | 从 `recordings/*.json` 按请求顺序回放响应（含 usage） | 无网络复现 live 结果 |
| live | 调用真实 DeepSeek；同时把请求、响应与 usage 写入运行目录 | 首版真实数据来源 |

- `live` 必须显式 `--live`，并要求 `TEF_MODEL_TESTS=1` 与可用 Key；任一条件不满足时拒绝运行，不静默降级为 deterministic。
- 不同模式分别统计，报告顶层记录 `mode`、模型名、温度与录制时间；不同模式的指标不得合并。
- `recorded` 只影响端到端层的模型调用；离线层不调用模型，模式字段仅用于标注。
- `recorded` 响应的顺序必须与样本轮次严格一致；缺失时该样本记为 error，不退化为 deterministic。

### 5.2 必要的运行时改造

1. `parseIntent(message, options?)` 增加可选的 `chat` 调用器与 `onUsage` 回调，返回 `usage?: TokenUsage`。默认行为不变。
2. `AgentTurnInput` 增加可选 `model?: { chat: ChatFn; onUsage?: (usage: TokenUsage) => void }`。usage 由调用方通过 `onUsage` 按轮次收集，不写入 `AgentTurnResult`，避免扩大运行时结果契约。
3. `ChatFn` 类型为 `(request: LLMChatRequest, signal?: AbortSignal) => Promise<LLMChatResponse>`，从 `@lymtrix/tef-runtime` 导出。
4. `LLMClient` 已经是 OpenAI 兼容实现，不需要修改请求协议；只需要把响应中的 `usage` 透出。

### 5.3 价目与成本

`pricing.ts` 维护价目快照，字段为 `capturedAt`、`source`、`model`、`inputPerMillion`、`outputPerMillion`。数值必须在实现阶段从 DeepSeek 官方价目页获取，并在 `docs/eval/phase-d-baseline.md` 中记录抓取日期与来源 URL；禁止使用记忆中的价格或空白占位值提交。成本计算公式：

```
cost = prompt_tokens / 1e6 * inputPerMillion + completion_tokens / 1e6 * outputPerMillion
```

无 `usage` 时成本输出 `null`，不估算。报告中同时展示 token 总数与成本，避免只看金额。

## 6. Fixture 网关

`fixtures.ts` 实现 `CrmBusinessGateway`：

| 方法 | 行为 |
|------|------|
| `searchCustomers` | 按 name/phone 在冻结 customers 中过滤，支持 limit |
| `getCustomer` | 按 id 返回冻结客户或 `null` |
| `getCredit` | 由客户快照与开放订单组合 `CreditRecord`；开放订单口径与生产 Prisma 网关一致：仅取 `pending`/`confirmed`/`shipped`，按 `createdAt` 倒序取前 20 条，不按 `balance` 过滤 |
| `getProducts` | 按 skus 返回冻结商品 |
| `searchProducts` | 按 term 模糊匹配冻结商品 |
| `getOrder` | 按 id 或 orderNo 返回冻结订单 |
| `query` | 按 `CRM_QUERY` operation 分派到上述类型化方法 |
| `executeEffects` | 记录调用并返回 `{ ok: true, refs: {} }`；评测不执行真实副作用 |

fixture 数据只读且深冻结（`Object.freeze` 或加载后不再修改）。端到端层通过 `gatewayFactory` 注入到契约工具，通过 `queryOptions.gateway` 注入到查询工具；CRM server 需要把这两个注入点透传给垂直工具（现有工具已支持，server 尚未接线）。

`getCredit` 的开放订单状态集合与排序已与生产 `prisma-gateway.ts` 对齐；除该口径外，fixture 与真实 Prisma 网关仍可能存在行为差异（如手机号匹配、模糊搜索语义、租户绑定校验），这些差异必须记录在报告的“已知限制”中，不能声称两者等价。

## 7. 指标与统计口径

| 指标 | 定义 |
|------|------|
| 决策混淆矩阵 | expected（allow/confirm/block/clarify）× actual（含 error） |
| 严格拦截率 | expect 为 block/confirm 的样本中，actual 与期望完全一致的比例 |
| 安全拦截率 | expect 为 block/confirm 的样本中，actual 为 block/confirm（未被放行）的比例 |
| 误拒率 | expect 为 allow 的样本中，actual 为 block 的比例 |
| 澄清召回率 | expect 为 clarify 的样本中，actual 为 clarify 的比例 |
| 意图准确率 | 端到端层 actual contract 与 expect.contract 的一致率 |
| 风险等级准确率 | 标注了 `expect.risk` 且 actual risk 非 `null` 的样本中，风险等级完全一致的比例 |
| 错误码准确率 | 标注了 `expect.code` 的样本中，actual code 与期望码一致的比例；实际缺失按未命中处理 |
| 槽位 F1 | 对 `expect.slots` 的每个字段计算 precision、recall、F1；只统计标注字段 |
| P50 / P95 延迟 | 样本总耗时；端到端层额外记录单轮耗时 |
| 成本 | 按 usage 与价目快照计算；无 usage 为 `null` |

补充规则：

- 决策为 `error` 的样本在严格拦截率中计为未拦截，在混淆矩阵中单列，不混入 allow。
- 槽位比较为严格相等（数字按数值、字符串 trim 后比较），不做模糊匹配；报告注明该口径。
- 槽位 F1 只在离线层计算：`expect.slots` 按契约归一化后的字段标注。端到端层的 actual slots 来自意图解析，字段形状不同，不计算该指标。
- 两层指标分别统计、分别生成报告；不得把 offline 与 e2e 样本合并计算拦截率、误拒率或延迟。
- 任一比例指标的分母为 0 时输出 `null`，不输出 0 或 100%，避免把“没有样本”误读为“表现完美”。
- P95 在 24 条样本上不具统计显著性，报告必须标注样本规模与“仅作工程趋势参考”。
- 每条样本在 JSON 中保留 expected、actual、contract、槽位明细、延迟、usage、traceId 与错误信息，便于人工复核。

## 8. 报告与 CLI

### 8.1 CLI

```bash
npm run eval -- --mode all
npm run eval -- --mode offline
npm run eval -- --mode e2e --recorded packages/tef-eval/recordings
npm run eval -- --mode all --live
```

参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| `--mode` | `all` | `offline` / `e2e` / `all` |
| `--samples` | `packages/tef-eval/samples/*.json` | 样本 glob |
| `--live` | 关闭 | 启用真实模型，需 `TEF_MODEL_TESTS=1` 与 Key |
| `--recorded` | 无 | 指定录制目录后使用 recorded 模式；与 `--live` 互斥 |
| `--out` | `eval-results/<runId>` | 输出目录 |
| `--verbose` | 关闭 | 输出每条样本执行日志 |

退出码：0 正常完成（不要求指标达标，样本级 `errorOutcome` 属于评测数据，不改变退出码）、1 配置或执行错误（含 `--live` 与 `--recorded` 同时出现）、2 样本集加载/校验失败。e2e 在缺少数据库时明确输出 `skipped: DATABASE_URL/TEF_DB_TESTS`，以退出码 0 结束但报告标记 `skipped`，不得把跳过计为通过。

`npm run eval` 通过 `vite-node` 运行 TypeScript CLI；新增 `vite.eval.config.ts`，复用 `vitest.config.ts` 中的 alias 与 resolve 配置。`vite-node` 作为 vitest 的直接依赖已存在于安装树中，本阶段显式加入 `devDependencies` 以避免依赖提升变化导致脚本失效。

### 8.2 输出

每次运行按层生成独立产物，不合并指标：

```
eval-results/<runId>/
  offline/results.json   # schemaVersion、runId、mode、layer、metrics、samples
  offline/report.md
  e2e/results.json
  e2e/report.md
  recordings/            # live 模式的模型响应录制
```

`--mode offline` 与 `--mode e2e` 只生成对应层；`--mode all` 生成两层。某层被跳过时，该层目录仍生成 `results.json`，`skipped` 与原因写入 `notes`，不生成可被误读为通过的报告。`sampleCount` 表示实际产出的 outcome 数（跳过层为 0），请求规模由 `requestedSampleCount` 单独记录，避免“24 条样本 / 0 条指标”的误读。

`results.json` 顶层字段：

```json
{
  "schemaVersion": 1,
  "runId": "eval_20261110T120000Z_ab12cd",
  "startedAt": "2026-11-10T12:00:00.000Z",
  "mode": "live",
  "layer": "e2e",
  "model": { "name": "deepseek-chat", "provider": "deepseek" },
  "sampleCount": 24,
  "requestedSampleCount": 24,
  "metrics": {},
  "samples": [],
  "notes": []
}
```

首版报告另存为 `docs/eval/phase-d-baseline.md` 入库，内容包括：运行命令、环境、样本构成、两种口径的拦截率、误拒率、澄清召回、意图准确率、槽位 F1、P50/P95、token 与成本、失败样本分析、样本规模限制与复现步骤。

## 9. 既有代码改造清单

| 文件 | 改造 | 兼容性 |
|------|------|--------|
| `packages/tef-runtime/src/intent.ts` | `parseIntent` 增加可选 `chat` / `onUsage`，返回 usage | 默认行为不变 |
| `packages/tef-runtime/src/runtime.ts` | `AgentTurnInput.model` 透传；usage 由调用方通过回调收集 | 可选字段 |
| `packages/tef-runtime/src/index.ts` | 导出 `ChatFn`、`TokenUsage` | 新增导出 |
| `verticals/crm-erp-mcp/src/server.ts` | 透传 `gatewayFactory` 到写工具、`gateway` 到查询工具 | 默认仍构造现有网关 |
| `packages/tef-eval/*` | 新增评测包 | 不被生产包依赖 |
| `package.json` | 新增 `eval`、`eval:live` 脚本与 `vite-node` devDependency | 不影响现有脚本 |
| `vitest.config.ts` | 将 `packages/tef-eval` 纳入测试 include | 已有通配符覆盖，按实际需要调整 |

改造必须保持 `npm test` 基线不下降；所有新增字段默认关闭或可选。

## 10. 测试策略与验收

### 10.1 测试

- `sample.test.ts`：schema 必填项、非法类别、非法决策、样本重复 id。
- `metrics.test.ts`：混淆矩阵、严格/安全拦截率、误拒率、澄清召回、风险等级准确率、错误码准确率、槽位 F1、成本计算、空样本集。
- `fixtures.test.ts`：六个查询方法与 `query` 分派；`executeEffects` 不写数据。
- `model.test.ts`：mock 顺序、recorded 缺失、live 缺 Key 拒绝、deterministic 不联网。
- `offline.test.ts`：24 条样本全部可执行；至少覆盖 allow/confirm/block 三类结果。
- `report.test.ts`：JSON 与 Markdown 渲染、`null` 成本、skipped 标记。
- `tests/integration/eval-e2e.test.ts`：3 条代表样本（normal L1、L2 confirm、adversarial block）在真实数据库与 fixture 网关下端到端跑通。
- 现有 414 项测试全部保持通过。

### 10.2 验收

```bash
npm run typecheck
npm run lint
npm run boundaries:check
npm run secrets:check
npm test
npm run eval -- --mode all --live
```

验收标准：

1. 离线层评测全部契约样本，查询工具样本标记 `skipped_non_contract`，输出完整指标。
2. 端到端层在 `TEF_DB_TESTS=1` 下跑通 24 条样本，无业务数据写入（effects 由评测执行器拦截）。
3. live 运行产生录制材料，`recorded` 模式可在断网条件下复现同一批响应。
4. 首版报告入库，指标与 `results.json` 一致。
5. 文档同步完成：`CLAUDE.md` Key Files、`docs/00-framework.md`、挑战杯说明书 §8.6、README、设计 spec 与实施计划交叉引用一致。

## 11. 风险与限制

| 风险 | 缓解 |
|------|------|
| 24 条样本不足以支持统计结论 | 报告明确标注样本规模，只用“工程趋势”表述，不宣称拦截率置信区间 |
| deterministic 解析器在模糊/对抗样本上表现差 | 这是被测量对象，不修改解析器迎合样本；离线层与端到端层分开报告 |
| fixture 与真实业务网关语义漂移 | 报告中列出已实现子集与差异；端到端层不声称等价于生产 |
| live 模型输出漂移或录制不可用 | 每次 live 自动录制；recorded 回放按顺序且缺响应即失败 |
| 端到端评测写治理表 | 使用独立租户与独立 trace；报告与 CLI 输出租户前缀与全部 traceId，清理由运维按前缀执行 |
| 评测不执行 effects | 报告明确“只测决策与预览”，不报告回滚成功率、执行延迟等未测指标 |
| 数据库缺失导致 e2e 跳过 | 报告标记 `skipped` 与原因，不以退出码 0 掩盖未执行 |

## 12. 相关文档

- [2026-11-09-tef-extraction-design.md](2026-11-09-tef-extraction-design.md) — 框架剥离与 P1/P2 收尾设计：包边界、API 契约、跨服务执行状态机
- [2026-11-09-phase-c-p1-execution-state-machine.md](../plans/2026-11-09-phase-c-p1-execution-state-machine.md) — Phase C 执行状态机、故障注入与并发计划
- [14-unified-architecture.md](../../technical/14-unified-architecture.md) — 统一架构框架（裁决版）
- [13-trusted-execution-architecture.md](../../technical/13-trusted-execution-architecture.md) — 可信执行架构详细设计
- [00-framework.md](../../00-framework.md) — 项目框架总览与实施进度
- [挑战杯项目设计说明书.md](../../competition/挑战杯项目设计说明书.md) — 第 8 章评测方案与第 7.4 节代码现状

---

## 自检记录

- 规格覆盖：对应设计文档 §8.4 Phase D 的五项交付；双层管道与 §8.5 可复现性设计一致。
- 占位符：无 TBD/TODO；价目快照要求在实现阶段填入并记录来源，属于明确动作而非待定设计。
- 内部一致性：样本 schema、决策映射、指标定义与报告字段使用同一组枚举；离线层与端到端层不合并统计。
- 范围：本设计只覆盖 Phase D 首版报告，不包含 300–500 条正式评测集与消融实验。

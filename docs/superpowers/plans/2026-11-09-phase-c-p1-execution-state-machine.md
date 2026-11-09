# Phase C：P1 收尾——执行状态机、故障注入与并发实施计划

> **状态：已完成（2026-11-10）。** 五个任务全部落地；最终基线 `TEF_DB_TESTS=1 npm test` 共 395 项测试通过（321 单元 + 74 真实数据库），typecheck、lint、boundaries:check、secrets:check、build 全部通过。已知限制与后续项见文末“完成状态与已知限制”。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把当前的“单事务 execute”改为可对账的两阶段执行状态机：预审计 → 执行副作用（幂等）→ 结果审计；补齐故障注入、崩溃恢复、并发幂等与库存不超卖验证。为后续独立存储/跨服务执行打基础。

**Architecture:** 新增 `execution_attempts` 治理表与 `EXECUTING / SUCCEEDED / FAILED / UNKNOWN` 状态。Phase 1 在本地事务内消费令牌/快照、重校验、写执行意图审计并提交；Phase 2 通过注入的 `EffectsExecutor` 执行声明式 effects（默认进程内 CRM 实现，幂等）；Phase 3 结算尝试、写结果审计与幂等响应。超时/崩溃进入 UNKNOWN，由 `reconcileExecutions` 用同一幂等键收敛。审计链新增 `pending` 结果，意图事件先于副作用提交。

**Tech Stack:** TypeScript 5.7、Prisma 7、PostgreSQL、Vitest 3、npm workspaces。

## Global Constraints

- 不改变 preview/confirm 的对外契约；execute 成功响应结构保持兼容。
- 默认进程内执行器必须幂等；同一 `idempotencyKey` 只产生一次副作用。
- 预审计失败则不得执行副作用；结果审计缺失必须可对账补齐。
- 所有租户表继续启用 RLS；`execution_attempts` 加 FORCE RLS。
- 计划写作时现有 373 项测试必须全部通过；完成后基线更新为 395 项（321 单元 + 74 数据库），并已同步全部文档。
- 用户已授权本地提交（仅本地，不推送）。
- 本计划只覆盖 Phase C；B3 存储拆分/Servers 在 C 之后。

---

## Task 1：执行状态模型与审计 pending

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/rls.sql`（或 `scripts/rls.mjs` 中的表清单）
- Modify: `packages/tef-core/src/types.ts`
- Modify: `packages/tef-mcp-kit/src/audit-chain.ts`
- Modify: `packages/tef-mcp-kit/src/tenant-scope.ts`
- Create: `packages/tef-core/src/execution.ts`

**Interfaces:**
- `ExecutionStatus = 'executing' | 'succeeded' | 'failed' | 'unknown'`
- `ExecutionAttempt` 类型
- `AuditResultType` 增加 `'pending'`

- [x] **Step 1：Prisma 模型**

在 `prisma/schema.prisma` 增加：

```prisma
enum ExecutionStatus {
  executing
  succeeded
  failed
  unknown
}

model ExecutionAttempt {
  id                      String          @id @default(cuid())
  tenantId                String
  tenant                  Tenant          @relation(fields: [tenantId], references: [id])
  attemptId               String          @unique
  traceId                 String
  previewId               String
  contract                String
  contractVersion         String
  intentHash              String
  toolName                String
  idempotencyKey          String
  status                  ExecutionStatus @default(executing)
  risk                    RiskOutcome
  effects                 Json
  expectedEvidenceVersion String?
  result                  Json?
  errorCode               String?
  errorMessage            String?
  preAuditEventId         String?
  resultAuditEventId      String?
  createdAt               DateTime        @default(now())
  updatedAt               DateTime        @updatedAt
  settledAt               DateTime?

  @@unique([tenantId, toolName, idempotencyKey])
  @@index([tenantId, status, updatedAt])
  @@map("execution_attempts")
}
```

在 `model Tenant` 增加 `executionAttempts ExecutionAttempt[]`；在 `enum AuditResult` 增加 `pending`。

- [x] **Step 2：RLS**

把 `execution_attempts` 加入 FORCE 清单（`tenant-scope.ts` 的 `RLS_TABLES_FORCED`、`prisma/rls.sql` 或 `scripts/rls.mjs` 的表清单），确保 `tenantId = current_setting('app.tenant_id')` 策略与 FORCE 生效。

- [x] **Step 3：核心类型**

`packages/tef-core/src/types.ts`：
- `AuditResultType` 增加 `'pending'`。
- `packages/tef-core/src/execution.ts`：

```ts
export type ExecutionStatus = 'executing' | 'succeeded' | 'failed' | 'unknown';

export interface ExecutionAttemptRecord {
  attemptId: string;
  tenantId: string;
  traceId: string;
  previewId: string;
  contract: string;
  contractVersion: string;
  intentHash: string;
  toolName: string;
  idempotencyKey: string;
  status: ExecutionStatus;
  risk: string;
  effects: unknown[];
  expectedEvidenceVersion?: string | null;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  preAuditEventId?: string | null;
  resultAuditEventId?: string | null;
}
```

由 core index 导出。

- [x] **Step 4：审计事件可选 eventId**

`AuditEventInput` 增加 `eventId?: string`；`append` 使用 `input.eventId ?? randomUUID()`，使对账可写确定性结果事件。

- [x] **Step 5：验证**

```bash
npx prisma generate
npx prisma db push
npm run typecheck
npx vitest run packages/tef-mcp-kit packages/tef-core
```

---

## Task 2：EffectsExecutor 端口与进程内 CRM 实现

**Files:**
- Create: `packages/tef-core/src/effects-executor-port.ts`
- Create: `verticals/crm-erp-mcp/src/gateway/effects-executor.ts`
- Modify: `verticals/crm-erp-mcp/src/index.ts`
- Modify: `src/app/api/internal/v1/effects/execute/route.ts`（复用它）

**Interfaces:**
- `EffectsExecutor { execute(input: EffectsExecuteRequest): Promise<EffectsExecuteResult> }`
- `EffectsExecutionUnknownError`：远程执行器在“可能已提交但响应丢失”时抛出；进程内执行器在冲突后重读幂等记录失败时同样抛出（无法确认副作用是否已提交）
- `createInProcessCrmEffectsExecutor(): EffectsExecutor`

- [x] **Step 1：端口**

`packages/tef-core/src/effects-executor-port.ts`：

```ts
import type { EffectsExecuteRequest, EffectsExecuteResult } from './business-gateway';

export interface EffectsExecutor {
  execute(input: EffectsExecuteRequest): Promise<EffectsExecuteResult>;
}
```

由 core index 导出。

- [x] **Step 2：进程内 CRM 实现**

把 `src/app/api/internal/v1/effects/execute/route.ts` 的核心事务逻辑抽到 `verticals/crm-erp-mcp/src/gateway/effects-executor.ts`：

```ts
export async function executeCrmEffectsInProcess(
  input: EffectsExecuteRequest,
): Promise<EffectsExecuteResult> {
  return withTenantScope(input.tenantId, async (tx) => {
    const existing = await tx.idempotencyRecord.findFirst({
      where: { tenantId: input.tenantId, toolName: 'internal.effects.execute', idempotencyKey: input.idempotencyKey },
    });
    if (existing) return { ...(existing.response as EffectsExecuteResult), replayed: true };

    const adapters = createCreditOrderAdapters(tx, input.tenantId, {
      previewId: input.previewId,
      traceId: input.traceId,
    });
    const result = await executeEffects(input.effects, adapters);
    const response: EffectsExecuteResult = { ok: true, refs: result.refs };
    await tx.idempotencyRecord.create({
      data: {
        tenantId: input.tenantId,
        toolName: 'internal.effects.execute',
        idempotencyKey: input.idempotencyKey,
        status: 'completed',
        response: response as unknown as object,
      },
    });
    return response;
  });
}

export function createInProcessCrmEffectsExecutor(): EffectsExecutor {
  return { execute: executeCrmEffectsInProcess };
}
```

捕获 `EffectExecutionError`：`CONFLICT` → `{ ok:false, refs:{}, error:{code:'CONFLICT',message} }`；`INTERNAL` → 同样返回 INTERNAL。抛出的未知错误也映射为 INTERNAL。

**兼容说明**：工具名沿用现有的 `internal.effects.execute`，不要改成 `crm.effects.execute`，否则已有幂等记录无法重放。Task 3/4 的测试与实现都使用该常量。

- [x] **Step 3：路由复用**

effects 路由在鉴权/开关/zod 校验后调用 `executeCrmEffectsInProcess`，不再自己写事务；保持现有响应与幂等语义。

- [x] **Step 4：验证**

```bash
npx vitest run verticals/crm-erp-mcp tests/integration/internal-gateway.test.ts
npm run typecheck
```

---

## Task 3：executeContract 两阶段状态机

**Files:**
- Modify: `packages/tef-mcp-kit/src/tools/contract.ts`
- Modify: `packages/tef-mcp-kit/src/index.ts`
- Modify: `verticals/crm-erp-mcp/src/tools/order.ts`
- Modify: `packages/tef-mcp-kit/src/principal.ts`（如需要）

**Interfaces:**
- `ContractWriteOptions.effectsExecutor: EffectsExecutor`（必填，由垂直注入；kit 不得 import 垂直包）
- 垂直包 `order.ts` 注入 `createInProcessCrmEffectsExecutor()`

- [x] **Step 1：Phase 1（本地事务）**

在 `executeContract` 内，把现有单事务拆成两阶段。Phase 1 事务负责：

1. 幂等记录查询（completed → 重放）。
2. `executionAttempt` 查询（若并发创建触发唯一约束 `P2002`，回滚后重新读取 attempt，按 executing/unknown 返回 in-progress，或按 succeeded 重放）：
   - `succeeded` → 重放结果（若无幂等记录则 `CONFLICT`）；
   - `executing` / `unknown` → 返回 `conflict('execution in progress or awaiting reconciliation')`，不消费令牌；
   - `failed` → 返回存储的失败响应。
3. 消费令牌、消费快照、校验 intentHash/契约版本。
4. 重校验；失败则作废令牌、写 Block 审计、返回 conflict（不创建 attempt）。
5. 创建 `executionAttempt`（status executing，effects=revalidated.effects，expectedEvidenceVersion=snapshot.evidenceDigest）。
6. 追加预审计（result `'pending'`，decision `'allow'`，eventId `${attemptId}:pre`），把 preAuditEventId 写入 attempt。
7. 提交。

- [x] **Step 2：Phase 2（外部副作用）**

```ts
if (!options.effectsExecutor) {
  throw new TefError('INTERNAL', 'EffectsExecutor is not configured');
}
const execResult = await options.effectsExecutor.execute({
  tenantId: principal.tenantId,
  // 执行器幂等域只有一个内部工具名，必须按工具作用域派生；
  // 裸业务 key 会让跨工具复用（创建/补偿）互相重放（C Task 3 fix）。
  idempotencyKey: scopedExecutorIdempotencyKey(toolName, idempotencyKey),
  previewId: snapshot.previewId,
  traceId: options.traceId,
  expectedEvidenceVersion: snapshot.evidenceDigest,
  effects: revalidated.effects,
});
```

**证据版本语义**：`expectedEvidenceVersion` 当前取预览快照的 `evidenceDigest`，仅作为证据版本标识透传；进程内执行器尚未比较该值。版本不一致 → `CONFLICT` 的判定与冲突后的重新预览流程待具备第二证据版本来源后实现（B3/跨服务），在此之前它不参与执行判定。

- [x] **Step 3：Phase 3（结算）**

新开 `withTenantScope` 事务：
- `ok:true`：attempt → succeeded，写 result；追加结果审计（eventId `${attemptId}:result`，result = `contract.auditResult ?? 'success'`）；写 TEF 幂等记录；返回现有成功响应。
- `ok:false` 且 code CONFLICT：attempt → failed；追加失败审计；写 TEF 幂等记录（失败响应）；返回 conflict。
- `ok:false` INTERNAL：attempt → failed；追加 failure 审计；返回 error。
- 执行器抛 `EffectsExecutionUnknownError`（或超时）：attempt → unknown；返回 `INTERNAL`/`CONFLICT`，提示对账中；不写幂等记录。进程内执行器的 `INTERNAL` 表示事务已回滚，按确定失败处理，不进入 unknown；例外是冲突后的幂等重读失败——此时副作用可能已提交，进程内执行器也抛 `EffectsExecutionUnknownError`，进入 unknown 交给对账。

- [x] **Step 4：垂直注入**

`verticals/crm-erp-mcp/src/tools/order.ts` 的四个操作在 options 中注入 `effectsExecutor: createInProcessCrmEffectsExecutor()`；保留调用方覆盖。

- [x] **Step 5：兼容旧测试**

现有 integration 测试应继续通过；如审计事件序列断言因新增 pre-audit 失败，更新为 `arrayContaining`/按 tool 过滤，不弱化安全断言。

- [x] **Step 6：验证**

```bash
TEF_DB_TESTS=1 npx vitest run tests/integration
npm run typecheck
npm run lint
```

---

## Task 4：对账与故障注入

**Files:**
- Create: `packages/tef-mcp-kit/src/reconcile-executions.ts`
- Modify: `packages/tef-mcp-kit/src/index.ts`
- Create: `tests/integration/execution-recovery.test.ts`

**Interfaces:**
- `reconcileExecutions(options): Promise<ReconciliationReport>`
- `ReconciliationReport { scanned, succeeded, failed, unknown }`

- [x] **Step 1：对账实现**

查询 `executionAttempt` 中 status `executing` 且 `updatedAt < now - threshold`，以及 `unknown`：

对每个 attempt：
- 调用 `effectsExecutor.execute`，幂等键必须用 `scopedExecutorIdempotencyKey(attempt.toolName, attempt.idempotencyKey)` 派生，与前台 Phase 2 完全一致；同时传 `attempt.previewId`、`attempt.traceId`、`attempt.effects`；
- 成功 → 用 Phase 3 的条件结算（`status in (executing, unknown)` + `resultAuditEventId` 去重）：succeeded + 结果审计 + 幂等记录；
- 确定失败 → failed + 失败审计；
- 仍未知 → 保持 unknown。
结果审计使用确定性 eventId，重复对账不重复写事件；`updateMany` 命中 0 行时必须重放已有记录或返回冲突，不能覆盖终态。

- [x] **Step 2：故障注入测试**

在 `tests/integration/execution-recovery.test.ts` 使用可注入的 fake executor：

1. 预审计后崩溃：创建/触发一个 executing attempt，调用 reconcile 且 executor 成功 → 副作用一次、succeeded、结果审计存在。
2. CRM 提交后超时：executor 第一次返回 unknown，reconcile 第二次返回成功（模拟幂等重放）→ 不重复副作用，最终 succeeded。
3. 结果审计前崩溃：executor 成功但 Phase 3 未执行（直接创建 attempt 或注入结算失败）→ reconcile 补写结果审计，链校验通过。
4. 预审计失败：模拟 Phase 1 审计写入失败 → 不调用 executor（用 spy 断言 0 次）。
5. 并发同幂等键：两个 execute 请求，一个创建 attempt，另一个返回 in-progress；副作用一次。
6. 令牌重放：同一 token 配不同 idempotencyKey → CONFLICT。
7. 库存并发预占不超卖（复用现有并发测试风格）。
8. 证据版本冲突 → CONFLICT，attempt 不进入执行。

- [x] **Step 3：验证**

```bash
TEF_DB_TESTS=1 npx vitest run tests/integration/execution-recovery.test.ts
TEF_DB_TESTS=1 npm test
npm run typecheck
npm run lint
```

---

## Task 5：文档与最终验收

**Files:**
- Modify: `verticals/crm-erp-mcp/src/gateway/effects-executor.ts`
- Modify: `packages/tef-mcp-kit/src/reconcile-executions.ts`
- Modify: `README.md`
- Modify: `docs/00-framework.md`
- Modify: `docs/technical/13-trusted-execution-architecture.md`
- Modify: `docs/technical/14-unified-architecture.md`
- Modify: `docs/superpowers/specs/2026-11-09-tef-extraction-design.md`
- Modify: `docs/superpowers/plans/2026-11-09-phase-c-p1-execution-state-machine.md`
- Modify: `docs/competition/挑战杯项目设计说明书.md`

- [x] **Step 0：对账健壮性 Minor**

1. `replayIfCommitted` 区分“记录不存在”与“读取异常”：读取异常不能返回确定 CONFLICT，应抛出 `EffectsExecutionUnknownError`，让状态机/对账进入 unknown。补一个单测（mock 读取抛错）。
2. 对账单条处理加 try/catch：`loadAttemptContext` 或 `reconcileAttempt` 抛异常时记录日志、计为 unknown，不中断整批。
3. 在 Phase C 文档的已知限制中记录：无法重建的尝试可能长期占用扫描批次（需要 `reconcileBlockedAt` 或游标，B3 处理）；失败审计结果类型在契约与工具注册处有重复推导（新增契约时需统一）。

- [x] **Step 1：文档**

- 更新执行语义：预审计 → effects → 结果审计；UNKNOWN 对账；审计链 `pending`。
- 更新测试基线（按实际新增数）。
- 标记 Phase C 完成；B3 存储拆分改为 Phase C 之后。
- 记录剩余 Phase C 未做项（若有）：跨服务 HTTP effects 接线、模型成本指标、完整评测。

- [x] **Step 2：最终验收**

```bash
npm run boundaries:check
npm run secrets:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
npm run build
```

Expected: 全部通过；文档计数与实际一致。

---

## 完成状态与已知限制

### 实际执行语义

一次写入分为三个阶段，跨越两个数据库事务：

1. **Phase 1（事务一）**：消费令牌与预览快照、重校验、创建 `execution_attempts`（`executing`），写结果类型为 `pending` 的预审计事件（`${attemptId}:pre`），提交后副作用才可能发生。
2. **Phase 2（副作用）**：通过注入的 `EffectsExecutor` 执行声明式 effects；执行器幂等键为 `scopedExecutorIdempotencyKey(toolName, idempotencyKey)`，与工具名作用域绑定，保证同一业务操作至多产生一次副作用。
3. **Phase 3（事务二）**：条件结算尝试，写结果审计（`${attemptId}:result`，确定性 eventId）与幂等记录；失败按 `failed` 结算，结果未知按 `unknown` 保留。

对账 `reconcileExecutions` 扫描 `unknown` 与超过静默期的 `executing` 尝试，用同一执行器幂等键重放：成功补写结果审计与幂等记录，确定失败补写失败审计，仍未知保持 `unknown`。因此系统保证 **at-most-once 副作用**，不宣称 exactly-once。

### 已知限制

- **无法重建的尝试会占用扫描批次**：预览快照或契约缺失的尝试每次对账都计入 `unknown`，且按 `updatedAt` 升序可能长期占据 `limit` 名额，挤压后续可收敛记录。需要 `reconcileBlockedAt` 或游标分页，留待 B3 存储拆分时处理。
- **失败审计结果类型有重复推导**：契约侧通过 `contract.auditResult` 推导（`compensated` → `compensation_failed`），工具注册侧则传入字面量（`verticals/crm-erp-mcp/src/tools/order.ts`）。新增契约时需统一为单一来源，避免两侧漂移。
- **证据版本冲突尚未参与执行判定**：`expectedEvidenceVersion` 目前只透传 `evidenceDigest`，进程内执行器不比较；版本不一致 → `CONFLICT` 的流程需第二证据版本来源，推迟到 B3/跨服务执行。
- **跨服务 HTTP effects 未接线**：`HttpCrmGateway.executeEffects` 尚未接入 `executeContract`，契约执行仍走本地 Prisma 适配器；B3 完成前禁止生产启用 `TEF_CRM_GATEWAY=http` 或 `TEF_CRM_EFFECTS_ENABLED=1`。接线时必须把网络超时与 5xx 映射为 `EffectsExecutionUnknownError`（当前 `toEffectsFailure` 固定映射为 `INTERNAL`），否则“可能已提交”会被误结算为确定失败。
- **TaskState 会话级崩溃恢复未完整验证**：Phase C 覆盖的是执行尝试（副作用）的对账恢复；对话会话从 TaskState 恢复的多轮验证仍属后续工作。
- **模型成本指标与完整评测未做**：属 Phase D（指标埋点、fixture、eval harness 与种子样本）。
- **未做生产级压测**：已有同幂等键、库存不超卖、并发对账等确定性并发测试，但没有持续性负载与 P95/成本压测。

### 验证记录（2026-11-10）

- `TEF_DB_TESTS=1 npm test`：395 项通过（321 单元 + 74 真实数据库）。
- `npm run typecheck`、`npm run lint`、`npm run boundaries:check`、`npm run secrets:check`、`npm run build`：全部通过。
- Phase C 新增/改写测试：执行状态机与结算、进程内执行器幂等与并发、对账故障注入（`tests/integration/execution-recovery.test.ts` 11 项）、执行结算（2 项）、执行器单测（4 + 3 项）。

---

## 后续计划索引

| 计划 | 内容 | 前置 |
|------|------|------|
| Phase B3 | 独立 TEF/运行时 schema、Tef Server、Docker Compose、跨服务 HTTP effects 接线与对账游标 | C 完成 |
| Phase D | P2 准备：指标埋点、fixture、eval harness 与种子样本 | C 完成 |

## 自检记录

- 规格覆盖：对应设计文档 §6.2 执行状态机、§6.3 故障语义、§8.3 Phase C 验收。
- 占位符：无 TBD/TODO；关键新文件给出完整代码，修改类步骤给出精确状态转换。
- 依赖决策：存储拆分必须在状态机之后，避免提前破坏单事务原子性（用户已确认）。
- 完成复核：Step 0 的两项健壮性修复（读取异常 → unknown、单条异常不中断整批）均有测试覆盖；文档计数与实测一致。

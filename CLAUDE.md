# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LyMtrix-TEF（Trusted Execution Framework）** — 一个为 AI Agent 的副作用建立确定性执行边界的可信执行框架。它不追求 LLM 输出确定，而是保证写操作只有在契约校验、证据加载、风险定级、预览快照、一次性令牌确认和幂等执行之后才产生副作用。

**参考实现**：义乌赊账订单场景的 CRM-ERP（`src/`，Phase 0 建设中）。CRM-ERP 不是项目的最终形态，而是框架的第一个验证垂直。

**开发理念**：以 MCP 工具链为可信执行边界，Agent Runtime 可替换，核心业务逻辑完全自主开发。

## Target Users

| 用户 | 需求 |
|------|------|
| AI 平台 / 基础设施团队 | 给 Agent 一个可控、可审计的写入边界 |
| 企业架构师 | 在现有系统前增加执行治理层 |
| Agent 开发者 | 用契约和工具替代散落的业务校验 |
| 研究者 / 评审者 | 可复现的评测与失效分析 |

参考实现的直接用户：义乌及周边中小微外贸、电商、小商品贸易企业。

## Document Management Rules

> **强制规则**：每次更新、创建、新增任何文档时，必须同步更新全部相关文档。

### 同步要求

| 操作类型 | 必须执行的同步任务 |
|----------|-------------------|
| 创建新文档 | 更新所有相关文档的"相关文档"章节 + CLAUDE.md Key Files |
| 更新现有文档 | 检查并更新关联文档的交叉引用 |
| 新增技术点 | 更新所有受影响文档的相关章节 |

### 同步检查清单

1. **相关文档章节** (`## 相关文档`)
   - 新增文档必须在所有关联文档的相关章节中添加
   - 格式：`- [文档名](路径) — 文档说明`

2. **CLAUDE.md Key Files**
   - 新增重要文档必须在 Key Files 中列出

3. **交叉引用**
   - 章节间引用（如 `[05-four-layer-safety.md](docs/technical/05-four-layer-safety.md)`）需保持一致
   - 文档数量变化时检查是否需要新增章节编号

4. **文档编号**
   - 新增文档使用下一个可用编号（如已有 13 篇，新增为 14）
   - 编号格式：`XX-document-name.md`

### 示例

**创建新文档 `docs/technical/14-new-feature.md` 时，必须同步更新：**

```markdown
# 1. 新增文档的相关文档章节
## 相关文档
- ...existing docs...
- [14-new-feature.md](docs/technical/14-new-feature.md) — 新功能说明

# 2. 新文档内添加相关文档引用
## 相关文档
- [05-four-layer-safety.md](docs/technical/05-four-layer-safety.md) — 六重防护机制详解
- [12-hook-system-design.md](docs/technical/12-hook-system-design.md) — Hook 系统详细设计

# 3. 更新 CLAUDE.md Key Files
## Key Files
- ...existing files...
- [docs/technical/14-new-feature.md](docs/technical/14-new-feature.md) — 新功能说明
```

## Core Principles

| # | 原则 | 说明 |
|---|------|------|
| 1 | 边界优先 | 先证明写入可控，再扩展业务功能 |
| 2 | AI权责隔离 | AI仅负责理解与提议，不直接触碰核心数据 |
| 3 | 可信执行边界 | 模型只提议，MCP 工具层负责校验、预览、确认、执行 |
| 4 | 规则前置 | 所有规则白名单固化，AI无法调用未授权能力 |
| 5 | 人在回路 | 高风险写入必须用户查看 diff 后二次确认 |
| 6 | 可审计可评测 | 每次决策可回放，核心能力有量化指标 |

## Architecture

> **权威文档**：[docs/technical/14-unified-architecture.md](docs/technical/14-unified-architecture.md)。当本文与其他文档冲突时，以 14 号文档的裁决为准。

### 分层架构

```
多端接入 → 认证/租户 → Agent Runtime（上下文+意图契约） → MCP 工具层（查询/预览/确认/执行） → 业务引擎 → 数据库/审计
```

### 信任域边界

| 信任域 | 层 | 是否承载安全责任 |
|--------|----|------------------|
| A 不可信 | L1 接入、L2 会话、L3 意图 | 否（可替换、可被攻破） |
| B 可信 | L4 MCP 工具层、L5 业务执行层 | **是**（确定性、不可绕过） |
| C 数据 | L6 PostgreSQL / Redis / Audit Store | 否（仅被 L4/L5 访问） |

### 自主开发层（不依赖任何 Agent 框架）

| 模块 | 说明 |
|------|------|
| 业务操作契约引擎 | Schema、前置条件、不变量、权限、风险、补偿 |
| MCP 工具链 | 查询、预览、执行、治理、知识五类工具，唯一写入通道 |
| 风险路由 | L0/L1/L2/Block 四档 |
| 人工确认工作流 | 一次性令牌、绑定操作哈希、过期与拒绝 |
| 业务规则引擎 | 插件化架构 |
| 审计与回放 | 事件溯源、哈希链、按实体/trace 回放 |
| 评测基准 | 中文业务写入评测集、基线、消融实验 |

### Agent Runtime（可替换）

| 能力 | 如何使用 |
|------|----------|
| 模型适配 | DeepSeek（默认）或任意 OpenAI 兼容模型 |
| MCP Client | 工具发现、调用、结果解析 |
| 上下文装配 | TaskState、最近对话、摘要、实体快照 |
| 任务状态 | 多轮对话、待确认操作、断点恢复 |
| 流式输出 | 响应展示 |

## Agent 与决策设计

### 核心分工

| 角色 | 职责 | 说明 |
|------|------|------|
| Agent Runtime | 意图理解、参数抽取、解释 | 单模型，结构化输出；可替换模型 |
| MCP 工具层 | 事实查询、契约校验、预览、执行 | 确定性系统，模型不可绕过 |
| 可选独立验证器 | 高风险/低置信度复核 | 不同模型/规则/证据源，不作为默认投票层 |
| 人工确认 | 高风险写入授权 | 查看 diff 与证据后确认 |

### 风险路由

| 等级 | 操作类型 | 执行路径 | 人工确认 |
|------|----------|----------|----------|
| **L0** | 查询类 | 查询工具直读 | 不需要 |
| **L1** | 低风险写入 | preview → execute | 不需要，但需幂等与审计 |
| **L2** | 高风险写入 | preview → 可选验证器 → 人工确认 → execute | 必须 |
| **Block** | 非法/越权/违反不变量 | 直接阻断 | 不进入确认 |

### 决策结果

- **通过**：契约校验与权限通过，按风险等级执行或等待确认
- **阻断**：违反前置条件、不变量、权限或策略，直接终止并记录原因
- **待确认**：风险为 L2，生成一次性确认令牌，等待人工授权
- **冲突**：并发或状态不一致，要求重新预览，不允许盲目重试

## Safety Guard

### 可信执行边界

```
L1 接入/认证 → L2 上下文/任务状态 → L3 意图契约 → L4 MCP 工具层 → L5 业务执行 → L6 数据/审计
                                      ↑ 可选独立验证器（仅高风险/低置信度）
```

| 层 | 机制 | 作用 |
|----|------|------|
| 事实层 | 工具 grounding | 客户、订单、库存、额度必须查库 |
| 输出层 | 结构化输出 | JSON Schema / zod 约束意图与参数 |
| 规则层 | 确定性校验 | 前置条件、不变量、权限、金额边界、状态机 |
| 预览层 | dry-run + diff | 展示“将要发生什么” |
| 确认层 | 人工确认 | 高风险操作由人查看 diff 后授权 |
| 执行层 | 事务 + 幂等 + 回滚 | 重复点击不重复执行，失败可补偿 |
| 审计层 | 事件日志 + 哈希链 | 可追溯、可回放、可追责 |

### 核心防护原则

| # | 原则 | 说明 |
|---|------|------|
| 1 | 边界优先 | 先证明写入可控，再扩展业务功能 |
| 2 | AI权责隔离 | AI仅负责理解与提议，不直接触碰核心数据 |
| 3 | 可信执行边界 | 模型只提议，MCP 工具层负责校验、预览、确认、执行 |
| 4 | 规则前置 | 所有规则白名单固化，AI无法调用未授权能力 |
| 5 | 人在回路 | 高风险写入必须用户查看 diff 后二次确认 |
| 6 | 可审计可评测 | 每次决策可回放，核心能力有量化指标 |

> **可信执行架构详见**：[docs/technical/13-trusted-execution-architecture.md](docs/technical/13-trusted-execution-architecture.md)

## Tech Stack

| 类别 | 技术 | 说明 |
|------|------|------|
| **Agent Runtime** | 自研轻量循环 + MCP Client | 模型适配、上下文装配、任务状态 |
| **工具协议** | MCP（`@modelcontextprotocol/sdk`） | 工具发现、Schema、调用 |
| **业务引擎** | TypeScript + Prisma 7 | 契约、规则、事务、补偿 |
| **数据库** | PostgreSQL、Redis | 业务数据、缓存、审计事件 |
| **前端** | Next.js 16 / React 19 | 当前代码已采用 |
| **AI** | DeepSeek（默认）或任意 OpenAI 兼容模型 | 模型可替换，工具链不变 |
| **评测** | Vitest + 自研评测 harness | 意图、拦截率、延迟、成本 |
| **部署** | Docker Compose（MVP）、K8s（后续） | 先跑通再扩展 |

## MCP 工具链定制

### 开发理念

- MCP 是工具协议，不是 Agent 框架
- Agent Runtime 只负责理解与编排，不持有数据库凭据
- 所有写入经过 MCP Server，权限、预览、确认、幂等、审计集中
- 模型可替换，工具链和护栏不变

### 特制工具链

| 模块 | 开发方式 | 原因 |
|------|----------|------|
| 业务操作契约引擎 | 完全自主 | 核心壁垒，领域规则沉淀 |
| MCP 工具链 | 完全自主 | 唯一写入通道，可测试 |
| 风险路由 | 完全自主 | 业务逻辑自主 |
| 审计与回放 | 完全自主 | 可信与合规 |
| 评测基准 | 完全自主 | 证明有效性，防止过拟合 |

## BASE/ 目录说明

- `BASE/claude-harness/` — Claude Code 源码分析平台（学习资料，不参与作品与产品）
- `BASE/cc-notebook/` — Claude Code 学习笔记与分析文档（学习资料，不参与作品与产品）

## Implementation Phases

| 阶段 | 时间 | 核心交付物 |
|------|------|------------|
| Phase 0 | 第1-2周 | 多租户底座、契约引擎，跑通“赊账订单”闭环：查询客户、查额度、查库存、预览订单、创建订单 |
| Phase 1 | 第3-4周 | L1 自动执行路径、dry-run/diff、确认令牌、幂等、冲突恢复、补偿、审计事件 |
| Phase 2 | 第5-6周 | 评测集（冻结上下文快照）、危险写入拦截率、误拒率、P95、成本；可选独立验证器 |
| Phase 3 | 第7-8周 | 参考垂直插件、计量计费与配额、角色细化、生产部署、软著/专利/论文材料 |
| 客户内测 | 第9-12周 | 3-5家试点，真实数据与反馈 |
| 正式版 | 第13-20周 | 行业插件库、生产部署 |

## 合规要求

- MCP SDK 及第三方依赖需保留原始版权声明，维护 THIRD_PARTY_NOTICES
- 严格遵守《个人信息保护法》《数据安全法》
- 所有 AI 写入必须经过可信执行边界与审计

## Git Branching Strategy

开发新功能时必须遵循以下规则：

| 分支 | 用途 | 命名规则 |
|------|------|----------|
| `main` | 生产环境分支 | - |
| `develop` | 开发集成分支 | - |
| `feature/*` | 功能开发分支 | `feature/功能名称` |

**开发流程：**
1. 从 `develop` 创建 `feature/xxx` 分支
2. 在 feature 分支上完成全部开发工作
3. 功能未完成前 **禁止合并** 到 `develop`
4. 功能完成后合并回 `develop`

**示例：**
```bash
# 创建功能分支
git checkout -b feature/customer-management develop

# 开发完成后合并
git checkout develop
git merge --no-ff feature/customer-management
```

## Key Files

- [docs/00-positioning.md](docs/00-positioning.md) — **定位与命名**：LyMtrix-TEF 的核心命题、边界、成熟度与参考实现关系
- [docs/00-framework.md](docs/00-framework.md) — **项目框架总览**：分层架构、信任域、核心机制、MCP 工具、数据模型、核心流程、代码映射与实施进度
- [docs/technical/14-unified-architecture.md](docs/technical/14-unified-architecture.md) — **统一架构框架（裁决版，单一权威）**：六条公理、信任域分层、L0/L1/L2/Block、预览快照、双层哈希、契约引擎、澄清协议、审计合规、多租户
- [README.md](README.md) — 完整项目文档
- [docs/technical/06-system-architecture.md](docs/technical/06-system-architecture.md) — 整体技术架构设计（MCP 可信执行版）
- [docs/technical/13-trusted-execution-architecture.md](docs/technical/13-trusted-execution-architecture.md) — 可信执行架构详细设计
- [docs/technical/03-mcp-tool-whitelist.md](docs/technical/03-mcp-tool-whitelist.md) — MCP 工具白名单体系
- [docs/technical/04-business-engine.md](docs/technical/04-business-engine.md) — 统一业务引擎设计
- [docs/superpowers/specs/2026-11-09-tef-extraction-design.md](docs/superpowers/specs/2026-11-09-tef-extraction-design.md) — 框架剥离与 P1/P2 收尾设计：包边界、API 契约、跨服务执行状态机

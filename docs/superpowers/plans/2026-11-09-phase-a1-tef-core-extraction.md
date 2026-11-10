# Phase A1：Monorepo 骨架与 tef-core 提取实施计划

> **执行状态**：Phase A1 已完成（2026-11-09，commits 8640c1a..1a0d333）。本计划保留为执行记录；A2–D 见设计文档 §8。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 npm workspaces 骨架，把不依赖 IO 的治理核心迁入 `@lymtrix/tef-core`，同时保持现有 295 个测试全部通过、运行时行为不变。

**Architecture:** 只做包边界迁移，不改变任何业务流程。旧路径保留 re-export 兼容层，Next.js 应用继续通过 `@/tef/*` 工作；核心包通过 ESLint 规则禁止导入 Prisma、Next、垂直契约与 MCP 实现。

**Tech Stack:** Node 22、npm workspaces、TypeScript 5.7、Vitest 3、ESLint 9、Next.js 16。

## Global Constraints

- 不改变任何运行时行为；迁移期间旧导入路径必须继续可用。
- 每个任务结束时执行 `npm run typecheck` 与 `npm run lint`，结果必须为 0 错误。
- 每个任务结束时执行 `npm test`，通过数不得低于 268（单元测试）；最后一项任务执行 `TEF_DB_TESTS=1 npm test`，必须 295 全部通过。
- 包名固定为：`@lymtrix/tef-core`。后续阶段使用 `@lymtrix/tef-mcp-kit`、`@lymtrix/tef-runtime`、`@lymtrix/tef-server`、`@lymtrix/tef-sdk`、`@lymtrix/vertical-crm-erp`。
- 不修改 `strict`、`target`、`moduleResolution` 等 TypeScript 全局选项。
- 默认不执行 git commit；只有用户明确授权后才提交。
- 本计划只覆盖 Phase A1。A2（mcp-kit/垂直/运行时）、B（服务化）、C（P1 收尾）、D（P2 准备）在 A1 完成后分别编写独立计划。

---

## Task 1：建立 workspaces 与 tef-core 包骨架

**Files:**
- Modify: `package.json`
- Create: `tsconfig.base.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Create: `next.config.ts`
- Create: `packages/tef-core/package.json`
- Create: `packages/tef-core/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces: workspace 包 `@lymtrix/tef-core`；根 tsconfig 与 Vitest 可解析该包及其子路径。

- [ ] **Step 1：在根 package.json 增加 workspaces**

修改 `package.json`，在 `"private": true` 之后加入：

```json
"workspaces": [
  "packages/*",
  "verticals/*",
  "apps/*"
],
```

- [ ] **Step 2：创建 tsconfig.base.json**

创建 `tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": false,
    "noEmit": true,
    "incremental": true,
    "module": "esnext",
    "esModuleInterop": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx"
  }
}
```

- [ ] **Step 3：让根 tsconfig 继承基础配置并增加包路径**

把 `tsconfig.json` 改为：

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@lymtrix/tef-core": ["./packages/tef-core/src/index.ts"],
      "@lymtrix/tef-core/*": ["./packages/tef-core/src/*"]
    },
    "plugins": [
      {
        "name": "next"
      }
    ]
  },
  "include": [
    "next-env.d.ts",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts",
    "**/*.ts",
    "**/*.tsx"
  ],
  "exclude": ["node_modules", "BASE"]
}
```

- [ ] **Step 4：更新 Vitest 别名与测试范围**

把 `vitest.config.ts` 的 `resolve.alias` 与 `test.include` 改为：

```ts
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@lymtrix\/tef-core\/(.*)$/,
        replacement: `${fileURLToPath(new URL('./packages/tef-core/src', import.meta.url))}/$1`,
      },
      {
        find: '@lymtrix/tef-core',
        replacement: fileURLToPath(new URL('./packages/tef-core/src/index.ts', import.meta.url)),
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'BASE', 'src/generated'],
    fileParallelism: false,
  },
});
```

- [ ] **Step 5：创建 tef-core 包清单**

创建 `packages/tef-core/package.json`：

```json
{
  "name": "@lymtrix/tef-core",
  "version": "0.1.0",
  "private": true,
  "description": "LyMtrix-TEF governance core: contracts, risk, hashing, effects.",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./*": "./src/*.ts"
  },
  "dependencies": {
    "zod": "^4.6.7"
  }
}
```

- [ ] **Step 6：创建空的包入口**

创建 `packages/tef-core/src/index.ts`：

```ts
// @lymtrix/tef-core public entry.
// 迁移期间保持为空；Task 2 填充导出。
export {};
```

- [ ] **Step 7：创建 Next 转译配置**

创建 `next.config.ts`：

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // workspace 包直接以 TypeScript 源码被应用引用，Next 需要转译它们。
  transpilePackages: ['@lymtrix/tef-core'],
};

export default nextConfig;
```

- [ ] **Step 8：安装 workspace 链接**

Run:

```bash
npm install
```

Expected: 命令成功，`package-lock.json` 更新，`node_modules/@lymtrix/tef-core` 成为指向 `packages/tef-core` 的符号链接。

- [ ] **Step 9：验证类型检查与测试**

Run:

```bash
npm run typecheck
npm test
```

Expected:

- `npm run typecheck` 无输出、退出码 0。
- `npm test` 输出 `268 passed | 27 skipped (295)`。

- [ ] **Step 10：检查点**

Run:

```bash
git status --short
```

Expected: 只出现本任务涉及的文件变更；不执行提交。

---

## Task 2：迁移纯治理模块到 tef-core

**Files:**
- Move: `src/tef/types.ts` → `packages/tef-core/src/types.ts`
- Move: `src/tef/errors.ts` → `packages/tef-core/src/errors.ts`
- Move: `src/tef/money.ts` → `packages/tef-core/src/money.ts`
- Move: `src/tef/canonical.ts` → `packages/tef-core/src/canonical.ts`
- Move: `src/tef/canonical.test.ts` → `packages/tef-core/src/canonical.test.ts`
- Move: `src/tef/hashing.ts` → `packages/tef-core/src/hashing.ts`
- Move: `src/tef/hashing.test.ts` → `packages/tef-core/src/hashing.test.ts`
- Move: `src/tef/redaction.ts` → `packages/tef-core/src/redaction.ts`
- Move: `src/tef/risk.ts` → `packages/tef-core/src/risk.ts`
- Move: `src/tef/risk.test.ts` → `packages/tef-core/src/risk.test.ts`
- Move: `src/tef/contract-engine.ts` → `packages/tef-core/src/contract-engine.ts`
- Move: `src/tef/contract-engine.test.ts` → `packages/tef-core/src/contract-engine.test.ts`
- Move: `src/tef/contract-registry.ts` → `packages/tef-core/src/contract-registry.ts`
- Move: `src/tef/effect-executor.ts` → `packages/tef-core/src/effect-executor.ts`
- Create: `src/tef/*.ts` 兼容 shim
- Modify: `packages/tef-core/src/types.ts`
- Modify: `packages/tef-core/src/index.ts`

**Interfaces:**
- Consumes: `@lymtrix/tef-core` 包骨架（Task 1）
- Produces: `@lymtrix/tef-core` 导出 `Contract`、`ContractEngine`、`contractEngine`、`contractRegistry`、`classifyRisk`、`resolveAmountThreshold`、`executeEffects`、`canonicalize`、`hash*`、`toCents`、`fromCents`、`prorateCents`、`formatCNY` 等公开符号；旧路径 `@/tef/*` 继续可用。

- [ ] **Step 1：移动文件**

Run:

```bash
mkdir -p packages/tef-core/src
git mv src/tef/types.ts packages/tef-core/src/types.ts
git mv src/tef/errors.ts packages/tef-core/src/errors.ts
git mv src/tef/money.ts packages/tef-core/src/money.ts
git mv src/tef/canonical.ts packages/tef-core/src/canonical.ts
git mv src/tef/canonical.test.ts packages/tef-core/src/canonical.test.ts
git mv src/tef/hashing.ts packages/tef-core/src/hashing.ts
git mv src/tef/hashing.test.ts packages/tef-core/src/hashing.test.ts
git mv src/tef/redaction.ts packages/tef-core/src/redaction.ts
git mv src/tef/risk.ts packages/tef-core/src/risk.ts
git mv src/tef/risk.test.ts packages/tef-core/src/risk.test.ts
git mv src/tef/contract-engine.ts packages/tef-core/src/contract-engine.ts
git mv src/tef/contract-engine.test.ts packages/tef-core/src/contract-engine.test.ts
git mv src/tef/contract-registry.ts packages/tef-core/src/contract-registry.ts
git mv src/tef/effect-executor.ts packages/tef-core/src/effect-executor.ts
```

Expected: 14 个文件移动成功，`git status` 显示 renamed。

- [ ] **Step 2：移除核心对 Prisma 的依赖**

修改 `packages/tef-core/src/types.ts`：

删除第一行：

```ts
import type { Prisma } from '@/generated/prisma';
```

把：

```ts
export type PrismaTx = Prisma.TransactionClient;
```

替换为：

```ts
/**
 * 垂直注入的事务句柄。框架核心不关心具体数据库类型；
 * Prisma 类型由 tef-mcp-kit 与垂直包在边界处声明。
 */
export type DbTx = unknown;
```

- [ ] **Step 3：创建旧路径兼容 shim**

用 Write 创建以下文件，内容与文件名对应：

`src/tef/errors.ts`：

```ts
export * from '@lymtrix/tef-core/errors';
```

`src/tef/money.ts`：

```ts
export * from '@lymtrix/tef-core/money';
```

`src/tef/canonical.ts`：

```ts
export * from '@lymtrix/tef-core/canonical';
```

`src/tef/hashing.ts`：

```ts
export * from '@lymtrix/tef-core/hashing';
```

`src/tef/redaction.ts`：

```ts
export * from '@lymtrix/tef-core/redaction';
```

`src/tef/risk.ts`：

```ts
export * from '@lymtrix/tef-core/risk';
```

`src/tef/contract-engine.ts`：

```ts
export * from '@lymtrix/tef-core/contract-engine';
```

`src/tef/contract-registry.ts`：

```ts
export * from '@lymtrix/tef-core/contract-registry';
```

`src/tef/effect-executor.ts`：

```ts
export * from '@lymtrix/tef-core/effect-executor';
```

`src/tef/types.ts`（特殊：保留迁移期 Prisma 事务类型）：

```ts
export * from '@lymtrix/tef-core/types';

import type { Prisma } from '@/generated/prisma';

/**
 * 迁移期兼容：Prisma 事务类型不属于框架核心。
 * Phase A2 会把该类型移到 tef-mcp-kit，并删除此 shim。
 */
export type PrismaTx = Prisma.TransactionClient;
```

- [ ] **Step 4：填充 core 公开入口**

把 `packages/tef-core/src/index.ts` 改为：

```ts
export * from './types';
export * from './errors';
export * from './money';
export * from './canonical';
export * from './hashing';
export * from './redaction';
export * from './risk';
export * from './contract-engine';
export * from './contract-registry';
export * from './effect-executor';
```

- [ ] **Step 5：运行 core 单元测试**

Run:

```bash
npx vitest run packages/tef-core
```

Expected: `canonical`、`hashing`、`risk`、`contract-engine` 测试全部通过，0 失败。

- [ ] **Step 6：运行全量类型检查与测试**

Run:

```bash
npm run typecheck
npm test
```

Expected:

- typecheck 退出码 0。
- `npm test` 输出 `268 passed | 27 skipped (295)`。

- [ ] **Step 7：检查点**

Run:

```bash
git status --short
```

Expected: 核心文件显示 renamed，`src/tef/` 下出现 10 个兼容 shim；不执行提交。

---

## Task 3：用 ESLint 固定 core 边界

**Files:**
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: 已迁移的 `packages/tef-core`
- Produces: `npm run lint` 对 `packages/tef-core/**` 执行基础设施导入禁令。

- [ ] **Step 1：增加 core 的 no-restricted-imports 配置**

在 `eslint.config.mjs` 的 `defineConfig([...])` 数组末尾、现有 `src/agent-runtime` 配置之后，加入：

```js
  {
    // 框架核心必须保持零 IO、零垂直依赖。
    // 任何数据库、Next.js、MCP 实现或 CRM 契约的导入都应被拒绝。
    files: ['packages/tef-core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/generated/prisma',
                '@/lib/prisma',
                '@/contracts/*',
                '@/mcp-server/*',
                '@/agent-runtime/*',
                '@prisma/*',
                'next',
                'next/*',
              ],
              message: 'tef-core must stay infrastructure-free; put IO in tef-mcp-kit or the vertical package.',
            },
          ],
        },
      ],
    },
  },
```

- [ ] **Step 2：运行 lint**

Run:

```bash
npm run lint
```

Expected: `0 errors`；警告数量不高于迁移前的 28 条。

- [ ] **Step 3：验证禁令生效**

临时在 `packages/tef-core/src/index.ts` 末尾加入：

```ts
import '@/generated/prisma';
```

Run:

```bash
npx eslint packages/tef-core/src/index.ts
```

Expected: 报告 `no-restricted-imports` 错误，提示 `tef-core must stay infrastructure-free`。

删除这行临时代码，再次运行：

```bash
npx eslint packages/tef-core/src/index.ts
```

Expected: 退出码 0。

- [ ] **Step 4：检查点**

Run:

```bash
git status --short
```

Expected: 只有 `eslint.config.mjs` 变更；不执行提交。

---

## Task 4：同步文档并做最终验证

**Files:**
- Modify: `README.md`
- Modify: `docs/00-framework.md`
- Modify: `docs/00-positioning.md`

**Interfaces:**
- Consumes: Task 1–3 的包结构
- Produces: 文档中的目录结构与实际一致；全量验收通过。

- [ ] **Step 1：更新 README 目录说明**

把 README 中 `src/` 与 `prisma/` 的说明改为反映新结构，至少包含：

```markdown
| 路径 | 说明 |
|------|------|
| `packages/tef-core/` | 框架治理核心（契约、风险、哈希、effects），不依赖 IO 与业务字段 |
| `src/` | Next.js 参考实现与尚未迁出的模块；后续阶段继续下沉到 packages 与 apps |
| `prisma/` | 参考实现数据模型；后续阶段拆分为 business / tef / runtime schema |
```

保留原有其他行不变。

- [ ] **Step 2：更新 00-framework 代码映射**

在 `docs/00-framework.md` 的代码映射章节增加一行：

```markdown
| 框架核心包 | 纯治理原语，无 IO 与垂直依赖 | `packages/tef-core/src/` | `canonical`、`hashing`、`risk`、`contract-engine` 测试随包迁移 |
```

- [ ] **Step 3：更新 00-positioning 的 L2 描述**

把 L2 一行的括号说明改为：

```markdown
| L2 框架 Beta | 核心与垂直解耦，具备 SDK、文档与测试 | 进行中：`@lymtrix/tef-core` 已独立成包且禁止基础设施依赖；MCP Kit、Runtime、SDK 与服务化在后续阶段完成 |
```

- [ ] **Step 4：运行最终验收**

Run:

```bash
npm run secrets:check
npm run typecheck
npm run lint
TEF_DB_TESTS=1 npm test
```

Expected:

- 密钥扫描通过。
- typecheck 退出码 0。
- lint 0 错误。
- `295 passed (295)`。

- [ ] **Step 5：检查点**

Run:

```bash
git status --short
```

Expected: 文档与配置文件变更；不执行提交。

---

## 后续计划索引

| 计划 | 内容 | 前置 |
|------|------|------|
| Phase A2 | 提取 `tef-mcp-kit`、`verticals/crm-erp-mcp`、`tef-runtime` | A1 完成 |
| Phase B | 服务化、API 网关、独立数据库与服务进程 | A2 完成 |
| Phase C | P1 收尾：执行状态机、故障注入、并发与崩溃恢复 | B 完成 |
| Phase D | P2 准备：指标埋点、fixture、eval harness 与种子样本 | C 完成 |

## 自检记录

- 规格覆盖：本计划覆盖设计文档 §8.1 Phase A 的步骤 1–4；Next.js 应用迁移到 `apps/crm-erp` 放在 A2/B，避免与包提取同时引入构建风险。
- 占位符：无 TBD/TODO；所有文件均有精确内容或命令。
- 类型一致性：`DbTx` 在 core 中定义；`PrismaTx` 仅存在于旧路径 shim，供现有代码在迁移期使用。

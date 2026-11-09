import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// 公理 I2：Runtime 只能引用 kit 的公共类型；kit 的实现子路径属于工具层。
// 这里显式列出全部子路径，避免新增子路径绕过规则（例如 tenant-scope）。
const RUNTIME_KIT_SUBPATHS = [
  'token',
  'preview-store',
  'audit-chain',
  'tools/contract',
  'tools/confirmation',
  'tools/audit',
  'tenant-scope',
  'prisma',
  'server',
  'transport',
  'principal',
  'envelope',
  'tenant',
];

const runtimeKitRestrictedPaths = [
  {
    name: '@lymatrix/tef-mcp-kit',
    allowTypeImports: true,
    message:
      'Runtime may only type-import from the kit root; kit values and implementation subpaths are forbidden (axiom I2). Call MCP tools through the injected connector.',
  },
  ...RUNTIME_KIT_SUBPATHS.map((subpath) => ({
    name: `@lymatrix/tef-mcp-kit/${subpath}`,
    allowTypeImports: true,
    message:
      'Kit implementation subpaths are forbidden to the Runtime (axiom I2); only type imports from the kit root are allowed. Call MCP tools through the injected connector.',
  })),
];

// TaskState 唯一的例外：它需要在 kit 的租户作用域内完成持久化，因此允许值导入
// tenant-scope；其余 kit 子路径仍只允许类型导入。
const taskStateKitRestrictedPaths = [
  {
    name: '@lymatrix/tef-mcp-kit',
    allowTypeImports: true,
    message:
      'TaskState may only type-import from the kit root; kit values and implementation subpaths are forbidden (axiom I2).',
  },
  ...RUNTIME_KIT_SUBPATHS.filter((subpath) => subpath !== 'tenant-scope').map(
    (subpath) => ({
      name: `@lymatrix/tef-mcp-kit/${subpath}`,
      allowTypeImports: true,
      message:
        'TaskState may only use the kit tenant-scoped store; other kit implementation subpaths are forbidden (axiom I2).',
    }),
  ),
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'BASE/**',
    'src/generated/**',
    'next-env.d.ts',
  ]),
  {
    // 公理 I2：模型无凭据。Agent Runtime 只能通过 MCP 工具访问业务数据，
    // 所以它不许直接 import Prisma、生成的客户端，或旧的业务引擎。
    // 用 lint 规则把这条架构约束变成可执行的检查，而不是靠代码评审时的自觉。
    // 规则同时覆盖 src/ 下的迁移 shim 与 packages/tef-runtime/ 的真实实现。
    files: ['src/agent-runtime/**/*.ts', 'packages/tef-runtime/**/*.ts'],
    ignores: ['packages/tef-runtime/src/task-state.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
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
            { group: ['@lymatrix/vertical-*'], message: 'The Runtime must not depend on a vertical package; use the injected MCP connector.' },
            { group: ['next', 'next/*'], message: 'The Runtime must not depend on Next.js; it is a framework package, not an app.' },
          ],
        },
      ],
      // TypeScript 版本才能用 allowTypeImports：Runtime 可以引用 kit 的公共类型，
      // 但 kit 的任何实现子路径都属于工具层，Runtime 不得取值导入。
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: runtimeKitRestrictedPaths,
        },
      ],
    },
  },
  {
    // TaskState 仍使用 Prisma 生成的类型（持久化在 kit 的 withTenantScope 内完成），
    // 但它同样不得导入契约、MCP 实现、垂直包或 Next.js。
    files: ['packages/tef-runtime/src/task-state.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // 允许 @/generated/prisma 的类型导入；真实持久化必须经 kit 的 withTenantScope。
          paths: [
            { name: '@/lib/prisma', message: 'TaskState must use the kit tenant-scoped store, not a raw Prisma client (axiom I2).' },
            { name: '@/engine', message: 'TaskState must not import the business engine.' },
            { name: '@/engine/BusinessEngine', message: 'TaskState must not import BusinessEngine.' },
          ],
          patterns: [
            {
              group: ['@/contracts/*', '@/mcp-server/*', '@/tef/preview-store', '@/tef/token', '@/tef/audit-chain', '@lymatrix/vertical-*', 'next', 'next/*'],
              message: 'TaskState may use Prisma types but must not import contracts, MCP implementations or verticals.',
            },
          ],
        },
      ],
      // TaskState 允许值导入 tenant-scope（持久化必须经过 kit 的租户作用域），
      // 其余 kit 子路径与 kit 根值导入仍然禁止。
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: taskStateKitRestrictedPaths,
        },
      ],
    },
  },
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
                '@/*',
                '@prisma/*',
                '@prisma/client',
                '@modelcontextprotocol/*',
                '@lymatrix/tef-mcp-kit',
                '@lymatrix/tef-mcp-kit/*',
                '@lymatrix/tef-mcp-kit*',
                '@lymatrix/tef-runtime',
                '@lymatrix/tef-runtime/*',
                '@lymatrix/tef-runtime*',
                '@lymatrix/vertical-*',
                'node:fs',
                'node:fs/promises',
                'node:child_process',
                'pg',
                'ioredis',
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
  {
    // MCP Kit 是通用工具层：可以持有 IO，但不得依赖具体垂直、Agent Runtime 或 Next.js。
    files: ['packages/tef-mcp-kit/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/contracts/*', '@/agent-runtime/*', '@lymatrix/vertical-*', '@lymatrix/tef-runtime', '@lymatrix/tef-runtime/*', '@lymatrix/tef-runtime*', 'next', 'next/*'],
              message: 'tef-mcp-kit must not depend on verticals, runtime or Next.js.',
            },
          ],
        },
      ],
    },
  },
  {
    // 垂直包只依赖框架核心与 MCP Kit；不得反向依赖 Runtime 或 Next.js 应用。
    files: ['verticals/crm-erp-mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/agent-runtime/*', '@/app/*', '@lymatrix/tef-runtime', '@lymatrix/tef-runtime/*', '@lymatrix/tef-runtime*', 'next', 'next/*'],
              message: 'The CRM vertical must not depend on the runtime or the app.',
            },
          ],
        },
      ],
    },
  },
]);

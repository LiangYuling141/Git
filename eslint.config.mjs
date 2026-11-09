import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

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
          ],
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
          patterns: [
            {
              group: ['@/contracts/*', '@/mcp-server/*', '@/tef/preview-store', '@/tef/token', '@/tef/audit-chain', '@lymatrix/vertical-*', 'next', 'next/*'],
              message: 'TaskState may use Prisma types but must not import contracts, MCP implementations or verticals.',
            },
          ],
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
                '@modelcontextprotocol/*',
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
              group: ['@/contracts/*', '@/agent-runtime/*', '@lymatrix/vertical-*', 'next', 'next/*'],
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
              group: ['@/agent-runtime/*', '@/app/*', 'next', 'next/*'],
              message: 'The CRM vertical must not depend on the runtime or the app.',
            },
          ],
        },
      ],
    },
  },
]);

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
    files: ['src/agent-runtime/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@/lib/prisma', message: 'Agent Runtime must not hold database credentials (axiom I2); go through an MCP tool.' },
            { name: '@/generated/prisma', message: 'Agent Runtime must not import the Prisma client (axiom I2).' },
            { name: '@/engine/BusinessEngine', message: 'Agent Runtime must not import BusinessEngine (axiom I2); go through an MCP tool.' },
            { name: '@/engine', message: 'Agent Runtime must not import the business engine (axiom I2).' },
            { name: '@/contracts/credit-order', message: 'Contract internals live in trust domain B; the Runtime may only call tools.' },
          ],
          patterns: [
            { group: ['@/tef/preview-store', '@/tef/token', '@/tef/audit-chain'], message: 'Token, snapshot and audit stores belong to the tool layer (L4/L5), not the Runtime.' },
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
]);

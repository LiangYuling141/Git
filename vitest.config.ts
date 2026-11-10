import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// 集成测试需要真实连接串与令牌密钥；统一从 .env 读取（已 gitignore）。
// CI 未提供 .env 时静默跳过，直接使用 workflow 注入的环境变量。
dotenv.config({ path: '.env', quiet: true });

// 测试默认不访问外部模型：只有显式设置 TEF_MODEL_TESTS=1 时才保留真实 Key。
// 否则本地 .env 配好 Key 后，集成测试会因模型调用超时而失败，CI 也不应依赖外部服务。
if (process.env.TEF_MODEL_TESTS !== '1') {
  process.env.DEEPSEEK_API_KEY = '';
}

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
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/**/*.test.ts', 'verticals/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'BASE', 'src/generated'],
    // 真实数据库集成测试共享 demo 租户夹具；并行文件会互相 reset，
    // 导致"单独跑通过、全量跑失败"的假象。顺序执行文件成本很低。
    fileParallelism: false,
  },
});

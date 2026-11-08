import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// 集成测试需要真实连接串与令牌密钥；统一从 .env 读取（已 gitignore）。
// CI 未提供 .env 时静默跳过，直接使用 workflow 注入的环境变量。
dotenv.config({ path: '.env', quiet: true });

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'BASE', 'src/generated'],
    // 真实数据库集成测试共享 demo 租户夹具；并行文件会互相 reset，
    // 导致"单独跑通过、全量跑失败"的假象。顺序执行文件成本很低。
    fileParallelism: false,
  },
});

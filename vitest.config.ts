import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// 集成测试需要真实连接串与令牌密钥；.env.local 优先于被 git 跟踪的 .env。
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

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

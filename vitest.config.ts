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
  },
});

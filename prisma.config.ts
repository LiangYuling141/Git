import dotenv from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// .env 是本地唯一配置入口（已 gitignore）；缺失时静默跳过，
// 以便 CI 直接用 workflow 注入的环境变量运行。
dotenv.config({ path: '.env', quiet: true });

// Prisma 7 不再允许在 schema.prisma 的 datasource 里写 url，
// 连接串统一从这里提供给 Migrate / db push / migrate diff。
// 运行时客户端仍走 src/lib/prisma.ts 的 PrismaPg driver adapter。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.mjs',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

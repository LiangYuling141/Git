import dotenv from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// .env.local 优先：真实密钥放在被 gitignore 覆盖的文件里，
// 而被 git 跟踪的 .env 只保留占位符。
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

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

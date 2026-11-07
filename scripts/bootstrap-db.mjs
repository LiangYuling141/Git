// 一次性引导脚本：在 `prisma db push` 之前建好 tenants 表并插入默认租户。
//
// 为什么需要它：schema 给既有表加的是 `tenantId TEXT NOT NULL DEFAULT 't_yiwu_demo'`
// 外加指向 tenants 的外键。PostgreSQL 在 ADD CONSTRAINT 时会校验既有行，
// 所以默认租户必须先存在，否则 db push 会在外键这一步失败。
//
// 幂等：可重复执行。
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: ['.env.local', '.env'] });

export const DEFAULT_TENANT_ID = 't_yiwu_demo';

const DDL = `
CREATE TABLE IF NOT EXISTS "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "dataResidency" TEXT NOT NULL DEFAULT 'CN',
    "thresholds" JSONB NOT NULL DEFAULT '{}',
    "enabledPlugins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key" ON "tenants"("slug");
`;

// 与 prisma/seed.mjs 保持一致：demo 租户阈值取 5,000，
// 以复现说明书 §7.2 里"总额 10,000 → L2"的判定（14 号文档 §3.2 把金额阈值定为租户配置项）。
export const DEFAULT_THRESHOLDS = {
  amountL2Threshold: 5000,
  overdueDaysL2Threshold: 30,
};

export async function ensureDefaultTenant(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(DDL);
    await client.query(
      `INSERT INTO "tenants" ("id", "name", "slug", "thresholds", "enabledPlugins", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, $5::text[], now())
       ON CONFLICT ("id") DO NOTHING`,
      [
        DEFAULT_TENANT_ID,
        '义乌赊账订单 demo 租户',
        'yiwu-demo',
        JSON.stringify(DEFAULT_THRESHOLDS),
        ['international_trade', 'inventory_reservation'],
      ],
    );
    const { rows } = await client.query('SELECT id, name, slug, thresholds FROM tenants ORDER BY id');
    return rows;
  } finally {
    await client.end();
  }
}

if (process.argv[2] === '--run') {
  ensureDefaultTenant()
    .then((rows) => {
      console.log('tenants:', JSON.stringify(rows, null, 2));
    })
    .catch((err) => {
      console.error('bootstrap failed:', err.message);
      process.exit(1);
    });
}

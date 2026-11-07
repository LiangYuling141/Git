// PostgreSQL Row-Level Security 的应用与验证。
//
//   node scripts/rls.mjs apply    幂等地应用 prisma/rls.sql
//   node scripts/rls.mjs verify   用真实查询证明隔离生效（不是只检查策略存在）
//
// verify 会在一个回滚的事务里建一个探针租户，然后证明：
//   1. 切到别的租户后看不见探针数据；
//   2. 跨租户写入被 WITH CHECK 拒绝；
//   3. 没设 app.tenant_id 时一行都读不到（fail-closed）。
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

dotenv.config({ path: ['.env.local', '.env'] });

const here = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(here, '..', 'prisma', 'rls.sql');

const PROBE_TENANT = 't_rls_probe';
const DEMO_TENANT = 't_yiwu_demo';

function connect() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return new pg.Client({ connectionString: process.env.DATABASE_URL });
}

async function apply() {
  const client = connect();
  await client.connect();
  try {
    await client.query(readFileSync(SQL_PATH, 'utf8'));
    const { rows } = await client.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity
        ORDER BY c.relforcerowsecurity DESC, c.relname`,
    );
    const policies = await client.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
    console.log(`applied. tables with RLS: ${rows.length}, policies: ${policies.rows[0].n}`);
    console.log('  FORCED :', rows.filter((r) => r.forced).map((r) => r.table_name).join(', '));
    console.log('  enabled:', rows.filter((r) => !r.forced).map((r) => r.table_name).join(', '));
  } finally {
    await client.end();
  }
}

// 让这套变更可逆：撤销策略并关闭 RLS，回到 apply 之前的状态。
async function drop() {
  const client = connect();
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT c.relname AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity`,
    );
    for (const row of rows) {
      await client.query(`DROP POLICY IF EXISTS tenant_isolation ON "${row.t}"`);
      await client.query(`ALTER TABLE "${row.t}" NO FORCE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE "${row.t}" DISABLE ROW LEVEL SECURITY`);
    }
    console.log(`dropped RLS on ${rows.length} tables: ${rows.map((r) => r.t).join(', ')}`);
  } finally {
    await client.end();
  }
}

async function verify() {
  const client = connect();
  await client.connect();
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  try {
    await client.query('BEGIN');

    // 探针租户与它的商品。products 是 FORCE 档，所以插入前必须先设对租户变量。
    await client.query(
      `INSERT INTO tenants (id, name, slug, "updatedAt") VALUES ($1, 'RLS 探针租户', 'rls-probe', now())
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_TENANT],
    );
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [PROBE_TENANT]);
    await client.query(
      `INSERT INTO products (id, "tenantId", sku, name, "updatedAt")
       VALUES ('p_probe', $1, 'PROBE-SKU', '探针商品', now())`,
      [PROBE_TENANT],
    );

    // 1. 切到 demo 租户后，探针数据不可见
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [DEMO_TENANT]);
    const leak = await client.query(`SELECT count(*)::int AS n FROM products WHERE id = 'p_probe'`);
    check('跨租户读取被隔离', leak.rows[0].n === 0, `demo 租户看到的探针商品数 = ${leak.rows[0].n}`);

    const visible = await client.query(`SELECT count(*)::int AS n FROM products`);
    const demoOwned = await client.query(
      `SELECT count(*)::int AS n FROM products WHERE "tenantId" = $1`,
      [DEMO_TENANT],
    );
    check(
      '可见行全部属于当前租户',
      visible.rows[0].n === demoOwned.rows[0].n,
      `可见 ${visible.rows[0].n} 行，其中属于 ${DEMO_TENANT} 的 ${demoOwned.rows[0].n} 行`,
    );

    // 切回探针租户，应该只看得到探针商品
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [PROBE_TENANT]);
    const probeView = await client.query(`SELECT count(*)::int AS n FROM products`);
    check('探针租户只看得到自己的数据', probeView.rows[0].n === 1, `探针租户可见 ${probeView.rows[0].n} 行`);

    // 2. 跨租户写入被 WITH CHECK 拒绝（用 SAVEPOINT，避免整个事务进入 aborted 状态）
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [DEMO_TENANT]);
    await client.query('SAVEPOINT rls_write_probe');
    let writeBlocked = false;
    let writeError = '';
    try {
      await client.query(
        `INSERT INTO products (id, "tenantId", sku, name, "updatedAt")
         VALUES ('p_evil', $1, 'EVIL-SKU', '越权写入', now())`,
        [PROBE_TENANT],
      );
    } catch (error) {
      writeBlocked = true;
      writeError = error.message;
    }
    await client.query('ROLLBACK TO SAVEPOINT rls_write_probe');
    check('跨租户写入被拒绝', writeBlocked, writeBlocked ? writeError : '写入竟然成功了');

    // 3. 审计表同样是 FORCE 档
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [PROBE_TENANT]);
    const auditVisible = await client.query(`SELECT count(*)::int AS n FROM audit_events`);
    check('审计事件表按租户隔离', auditVisible.rows[0].n === 0, `探针租户可见审计事件 ${auditVisible.rows[0].n} 条`);

    await client.query('ROLLBACK');

    // 4. 事务外没有 app.tenant_id：一行都读不到（fail-closed）
    const unscoped = await client.query(`SELECT count(*)::int AS n FROM products`);
    check('未设租户变量时 fail-closed', unscoped.rows[0].n === 0, `未设变量时可见 ${unscoped.rows[0].n} 行`);

    const flags = await client.query(
      `SELECT c.relname AS t, c.relforcerowsecurity AS f
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity ORDER BY 1`,
    );
    const forced = flags.rows.filter((r) => r.f).map((r) => r.t);
    check('FORCE 档表已生效', forced.length >= 7, `FORCE: ${forced.join(', ')}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    check('验证过程无异常', false, error.message);
  } finally {
    await client.end();
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(failed === 0 ? `\nall ${results.length} RLS checks passed` : `\n${failed} of ${results.length} checks FAILED`);
  if (failed > 0) process.exitCode = 1;
}

const command = process.argv[2];
if (command === 'apply') {
  await apply();
} else if (command === 'verify') {
  await verify();
} else if (command === 'drop') {
  await drop();
} else {
  console.error('usage: node scripts/rls.mjs <apply|verify|drop>');
  process.exitCode = 2;
}

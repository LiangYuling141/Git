// PostgreSQL Row-Level Security 的应用与验证。
//
//   node scripts/rls.mjs apply             幂等地应用 prisma/rls.sql
//   node scripts/rls.mjs verify            用真实查询证明隔离生效（不是只检查策略存在）
//   node scripts/rls.mjs drop              撤销策略并关闭 RLS，回到 apply 之前
//   node scripts/rls.mjs prepare-app-role  建立非超级用户的应用角色（需要 CREATEROLE）
//   node scripts/rls.mjs app-role-url      打印以该角色连接的 DATABASE_URL
//
// 重要：超级用户与 BYPASSRLS 角色永远绕过 RLS，FORCE 也拦不住；表 owner 在未 FORCE
// 的表上也绕过。所以"验证通过"只有在非特权角色上才有意义——verify 会先检查当前角色，
// 发现是超级用户就直接拒绝执行，而不是产出一堆看起来像数据问题的 FAIL。
//
// 本地开发库通常以表 owner 身份连接，此时只有 FORCE 档真正受约束；
// CI 会先 prepare-app-role，再用该角色 verify，这时所有启用 RLS 的表都受约束。
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

// 应用角色。RLS 对超级用户和（未 FORCE 时的）表 owner 都不生效，
// 所以隔离验证必须用一个既非超级用户、也非表 owner 的角色来跑。
const APP_ROLE = process.env.APP_DB_ROLE ?? 'lymatrix_app';
const APP_ROLE_PASSWORD = process.env.APP_DB_PASSWORD ?? 'lymatrix_app_ci_password';

function connect(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Client({ connectionString });
}

function appRoleUrl() {
  const url = new URL(process.env.DATABASE_URL);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PASSWORD;
  return url.toString();
}

/**
 * 建立非超级用户的应用角色并授权。
 *
 * 需要当前连接具备 CREATEROLE（CI 的 postgres 用户有；本地开发用户通常没有，
 * 本地可直接用表 owner 身份验证 FORCE 档）。
 */
async function prepareAppRole() {
  const client = connect();
  await client.connect();
  try {
    // 角色名要拼进 SQL，所以只接受安全的标识符；密码来自环境变量，
    // 而 CREATE/ALTER ROLE 是工具语句、不支持绑定参数，只能用 escapeLiteral。
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(APP_ROLE)) {
      throw new Error(`APP_DB_ROLE "${APP_ROLE}" is not a safe SQL identifier`);
    }
    const passwordLiteral = client.escapeLiteral(APP_ROLE_PASSWORD);

    const me = await client.query(`SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`);
    if (!me.rows[0]?.rolcreaterole && !me.rows[0]?.rolsuper) {
      throw new Error(
        `current role cannot CREATE ROLE; run this step as a privileged role (CI does), or verify as the table owner`,
      );
    }
    const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
    const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
    await client.query(
      `${verb} ROLE ${APP_ROLE} LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEROLE NOBYPASSRLS`,
    );
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE}`);
    await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${APP_ROLE}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${APP_ROLE}`);
    console.log(`prepared non-superuser app role "${APP_ROLE}" (NOBYPASSRLS)`);
  } finally {
    await client.end();
  }
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
    // 前置断言：超级用户与 BYPASSRLS 角色永远绕过 RLS，FORCE 也拦不住。
    // 在这种连接上"验证通过"是假象，所以直接拒绝继续，而不是产出一堆费解的 FAIL。
    const me = await client.query(
      `SELECT current_user AS usr, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const role = me.rows[0];
    if (role?.rolsuper || role?.rolbypassrls) {
      await client.end();
      console.error(
        `refusing to verify as "${role.usr}": superuser/BYPASSRLS roles always bypass row-level security.\n` +
          `Run this as a non-superuser role, e.g.\n` +
          `  node scripts/rls.mjs prepare-app-role\n` +
          `  DATABASE_URL="$(node scripts/rls.mjs app-role-url)" node scripts/rls.mjs verify`,
      );
      process.exitCode = 1;
      return;
    }
    const ownsProbe = await client.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'products'`,
    );
    const isOwner = ownsProbe.rows[0]?.owner === role?.usr;
    console.log(
      `verifying as "${role.usr}" (table owner: ${isOwner ? 'yes — only the FORCE tier is enforced' : 'no — every RLS table is enforced'})`,
    );

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
try {
  if (command === 'apply') {
    await apply();
  } else if (command === 'verify') {
    await verify();
  } else if (command === 'drop') {
    await drop();
  } else if (command === 'prepare-app-role') {
    await prepareAppRole();
  } else if (command === 'app-role-url') {
    process.stdout.write(appRoleUrl());
  } else {
    console.error('usage: node scripts/rls.mjs <apply|verify|drop|prepare-app-role|app-role-url>');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`${command ?? 'rls'} failed: ${error.message}`);
  process.exitCode = 1;
}

// 义乌赊账订单参考场景的种子数据。
//
// 数据对齐 docs/competition/挑战杯项目设计说明书.md §7.2 的场景走查：
// 「给伟业公司下一单，5000 个圣诞球，单价 2 块，先付 30% 定金，余款 30 天账期。」
// 需要两个"伟业"候选触发澄清、总额 10,000、超过租户阈值 5,000 判定 L2。
//
// 幂等：全部按显式主键 upsert，可重复执行。
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const TENANT_ID = 't_yiwu_demo';

// §7.2 第 5 步的租户阈值。14 号文档 §3.2 把金额阈值定为租户配置项，
// 这里取 5,000 以复现说明书里的 L2 判定（13 号文档契约示例里的 10,000 已被 14 号裁决取代）。
// amountL2Threshold 由框架的 classifyRisk 读取；overdueDaysL2Threshold 是垂直规则，由契约读取。
const THRESHOLDS = { amountL2Threshold: 5000, overdueDaysL2Threshold: 30 };

const CUSTOMERS = [
  // 场景走查里被选中的那一个
  ['c_weiye_import', '义乌市伟业进出口有限公司', '13905791001', 50000, 40000, 0, 'normal', false],
  // 同名候选，用于触发澄清
  ['c_weiye_craft', '义乌市伟业工艺品厂', '13905791002', 20000, 0, 0, 'normal', false],
  // 可用额度仅 3,000，用于演示超额赊账被阻断
  ['c_tight_credit', '义乌市恒信玩具商行', '13905791003', 8000, 5000, 0, 'normal', false],
  // 逾期 45 天的高风险客户，用于演示 overdueDays 触发 L2
  ['c_overdue', '义乌市远大礼品有限公司', '13905791004', 100000, 0, 45, 'high_risk', true],
  ['c_vip', '义乌市锦绣家居用品有限公司', '13905791005', 300000, 0, 0, 'vip', false],
];

const PRODUCTS = [
  ['p_xmas_ball', 'XMAS-BALL-01', '圣诞球 直径6cm 混色', 2, 20000, 0, '个'],
  ['p_led_string', 'LED-STRING-02', 'LED 铜线灯串 3米20灯', 8.5, 5000, 0, '条'],
  // 库存仅 300，用于演示库存不足阻断
  ['p_plastic_flower', 'PLASTIC-FLOWER-03', '仿真塑料花 单支', 1.2, 300, 0, '支'],
  ['p_storage_box', 'STORAGE-BOX-04', '折叠收纳箱 大号', 15, 1200, 0, '个'],
];

const MEMBERS = [
  ['tm_admin', 'admin', 'owner'],
  ['tm_demo', 'demo-user', 'sales'],
  ['tm_test', 'test-user-001', 'viewer'],
];

// 演示用户。空库（例如 CI）上必须先有用户，成员关系才建得起来，
// 否则 resolveTenantContext 会因为找不到用户而拒绝，闭环测试直接失败。
const USERS = [
  ['admin', 'Admin User', 'admin@example.com'],
  ['demo-user', 'Demo User', 'demo@example.com'],
  ['test-user-001', 'testuser', 'test@test.com'],
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');

  // products 属于 RLS FORCE 档：不设租户变量，WITH CHECK 会直接拒绝写入。
  // is_local=true 让变量只在这个事务内有效。
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_ID]);

  await client.query(`UPDATE tenants SET thresholds = $1::jsonb, "updatedAt" = now() WHERE id = $2`, [
    JSON.stringify(THRESHOLDS),
    TENANT_ID,
  ]);

  for (const [id, name, phone, creditLimit, creditUsed, overdueDays, customerType, isHighRisk] of CUSTOMERS) {
    await client.query(
      `INSERT INTO customers
         (id, "tenantId", name, phone, "creditLimit", "creditLine", "creditUsed",
          "overdueDays", "customerType", status, "isHighRisk", "monthlyTransaction",
          "onboardingStatus", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,'completed',now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, phone = EXCLUDED.phone,
         "creditLimit" = EXCLUDED."creditLimit", "creditLine" = EXCLUDED."creditLine",
         "creditUsed" = EXCLUDED."creditUsed", "overdueDays" = EXCLUDED."overdueDays",
         "customerType" = EXCLUDED."customerType", "isHighRisk" = EXCLUDED."isHighRisk",
         "updatedAt" = now()`,
      [id, TENANT_ID, name, phone, creditLimit, creditLimit, creditUsed, overdueDays, customerType, isHighRisk, creditUsed * 3],
    );
  }

  for (const [id, sku, name, unitPrice, availableQty, reservedQty, unit] of PRODUCTS) {
    await client.query(
      `INSERT INTO products
         (id, "tenantId", sku, name, "unitPrice", "availableQty", "reservedQty", unit, "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (id) DO UPDATE SET
         sku = EXCLUDED.sku, name = EXCLUDED.name, "unitPrice" = EXCLUDED."unitPrice",
         "availableQty" = EXCLUDED."availableQty", "reservedQty" = EXCLUDED."reservedQty",
         unit = EXCLUDED.unit, "updatedAt" = now()`,
      [id, TENANT_ID, sku, name, unitPrice, availableQty, reservedQty, unit],
    );
  }

  for (const [id, userName, email] of USERS) {
    await client.query(
      `INSERT INTO users (id, "tenantId", "userName", email, "updatedAt")
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (id) DO UPDATE SET "userName" = EXCLUDED."userName", "tenantId" = EXCLUDED."tenantId", "updatedAt" = now()`,
      [id, TENANT_ID, userName, email],
    );
  }

  for (const [id, userId, role] of MEMBERS) {
    // 只有真实存在的用户才建成员关系：种子不应因为演示用户缺失而失败。
    const exists = await client.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if (!exists.rowCount) continue;
    await client.query(
      `INSERT INTO tenant_members (id, "tenantId", "userId", role)
       VALUES ($1,$2,$3,$4::"TenantRole")
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
      [id, TENANT_ID, userId, role],
    );
    await client.query(`UPDATE users SET "tenantId" = $1 WHERE id = $2`, [TENANT_ID, userId]);
  }

  // 统计必须在事务内做：products 是 RLS FORCE 档，
  // COMMIT 之后 app.tenant_id 失效，查出来会是 0 行而不是真实数量。
  const summary = await client.query(
    `SELECT
       (SELECT count(*)::int FROM customers      WHERE "tenantId" = $1) AS customers,
       (SELECT count(*)::int FROM products       WHERE "tenantId" = $1) AS products,
       (SELECT count(*)::int FROM tenant_members WHERE "tenantId" = $1) AS members`,
    [TENANT_ID],
  );

  await client.query('COMMIT');
  console.log('seeded tenant', TENANT_ID, JSON.stringify(summary.rows[0]));
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}

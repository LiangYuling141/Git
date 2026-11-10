-- =============================================================================
-- PostgreSQL Row-Level Security（docs/technical/14-unified-architecture.md §11.1）
--
-- 隔离机制：MCP Server 每请求 SET LOCAL app.tenant_id，应用层 WHERE 作为第二道防线。
-- current_setting('app.tenant_id', true) 在变量缺失时返回 NULL，
-- 比较结果为 NULL 而非 true，行被过滤掉——也就是 fail-closed。
--
-- 连接角色 lymtrix 是这些表的 owner，而 owner 默认不受 RLS 约束。
-- 所以只有 FORCE ROW LEVEL SECURITY 的表才是真正被强制隔离的。
-- 下面按"谁在访问这张表"分两档，理由写在各自的分节注释里。
--
-- 幂等：可重复执行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 第一档：FORCE。这些表只被 TEF 代码访问，而 TEF 的每条路径都经过
-- withTenantScope()，一定会先设好 app.tenant_id。强制隔离不会误伤任何东西，
-- 而它们恰好是令牌、快照、幂等与审计链——可信边界上最不能泄露的部分。
-- -----------------------------------------------------------------------------

ALTER TABLE audit_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events        FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads   FORCE  ROW LEVEL SECURITY;
ALTER TABLE preview_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE preview_snapshots   FORCE  ROW LEVEL SECURITY;
ALTER TABLE confirmation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmation_tokens FORCE  ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE  ROW LEVEL SECURITY;
ALTER TABLE task_states         ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_states         FORCE  ROW LEVEL SECURITY;
ALTER TABLE execution_attempts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_attempts  FORCE  ROW LEVEL SECURITY;
ALTER TABLE products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE products            FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audit_events;
CREATE POLICY tenant_isolation ON audit_events
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON audit_chain_heads;
CREATE POLICY tenant_isolation ON audit_chain_heads
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON preview_snapshots;
CREATE POLICY tenant_isolation ON preview_snapshots
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON confirmation_tokens;
CREATE POLICY tenant_isolation ON confirmation_tokens
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON idempotency_records;
CREATE POLICY tenant_isolation ON idempotency_records
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON task_states;
CREATE POLICY tenant_isolation ON task_states
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON execution_attempts;
CREATE POLICY tenant_isolation ON execution_attempts
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON products;
CREATE POLICY tenant_isolation ON products
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- -----------------------------------------------------------------------------
-- 第二档：只 ENABLE，不 FORCE。这些业务表仍被遗留 REST 路由直接访问，
-- 而那些路由还没有走 withTenantScope()。现在 FORCE 会让它们静默返回空结果集，
-- 那比没有隔离更危险。Phase 0 对这一档的强制隔离发生在应用层
-- （TEF 的每个查询都显式带 where.tenantId）；
-- 生产部署要么把应用改成非 owner 角色，要么在遗留路由迁移完成后补 FORCE。
-- -----------------------------------------------------------------------------

ALTER TABLE customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE whitelist_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON customers;
CREATE POLICY tenant_isolation ON customers
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON orders;
CREATE POLICY tenant_isolation ON orders
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON payments;
CREATE POLICY tenant_isolation ON payments
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON whitelist_entries;
CREATE POLICY tenant_isolation ON whitelist_entries
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON confirmation_requests;
CREATE POLICY tenant_isolation ON confirmation_requests
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- -----------------------------------------------------------------------------
-- 不设 RLS：tenants 与 tenant_members 是租户上下文的来源。
-- 在知道"自己属于哪个租户"之前必须先能读到成员关系，
-- 对它们套 RLS 会让引导过程自我锁死。它们的访问由 resolveTenantContext() 收敛。
-- system_logs / hook_execution_logs 没有 tenantId 列，属于运维侧日志。
-- -----------------------------------------------------------------------------

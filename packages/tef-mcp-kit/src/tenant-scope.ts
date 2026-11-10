import { prisma } from '@/lib/prisma';
import { TefError } from '@lymtrix/tef-core';
import type { PrismaTx } from './prisma';

/**
 * 租户作用域数据访问（§11.1）。
 *
 * RLS 策略读的是 PostgreSQL 会话变量 app.tenant_id，而 `set_config(..., true)`
 * 的 is_local 语义只在事务内有效。所以每次租户作用域访问都必须是一个事务：
 * 先设变量，再执行查询。连接归还连接池后变量随之失效，不会串到下一个请求。
 *
 * 应用层的 `where.tenantId` 是第二道防线——即使策略被误配，
 * 显式条件也拦得住跨租户读写。
 */

export const TENANT_SESSION_VAR = 'app.tenant_id';

export function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    // 空租户会让 RLS 变成"拒绝一切"。这里提前失败，避免把配置错误
    // 伪装成"数据不存在"这种难以排查的现象。
    throw new TefError('INTERNAL', 'tenantId must be a non-empty string');
  }
}

/** 在事务内设置租户会话变量后执行 fn。 */
export async function withTenantScope<T>(tenantId: string, fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
  assertTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${TENANT_SESSION_VAR}, ${tenantId}, true)`;
    return fn(tx as PrismaTx);
  });
}

/** 只读场景的别名。语义相同，用来在调用点表明意图。 */
export const withTenantRead = withTenantScope;

/** 供 RLS 策略与审计脚本共用的变量名。 */
export const RLS_TABLES_FORCED = [
  'audit_events',
  'audit_chain_heads',
  'preview_snapshots',
  'confirmation_tokens',
  'idempotency_records',
  'task_states',
  'execution_attempts',
  'products',
] as const;

export const RLS_TABLES_ENABLED_ONLY = [
  'customers',
  'orders',
  'payments',
  'users',
  'sessions',
  'whitelist_entries',
  'confirmation_requests',
  'audit_logs',
] as const;

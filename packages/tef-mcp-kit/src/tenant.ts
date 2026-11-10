import type { Prisma } from '@/generated/prisma';
import { TefError } from '@lymtrix/tef-core';
import type { TenantRole } from '@lymtrix/tef-core';

/**
 * 租户识别与工具 scope（§11）。
 *
 * 租户不是 Phase 3 的可选项：令牌、幂等键、契约权限、越权缓解全部预设 tenantId 存在。
 * 角色 → scope 的映射由服务端强制校验，不信任模型声明。
 */

/**
 * schema 里所有 `tenantId` 列的默认值。
 * 它只是让既有演示数据无损落入首个租户的迁移手段，不是"可以不带租户"的许可：
 * TEF 的每条数据访问路径都必须显式解析租户。
 */
export const DEFAULT_TENANT_ID = 't_yiwu_demo';

/** §6.4：工具可见性按 MCP client 身份注册，而不是靠文档约定。 */
export type ClientKind = 'agent' | 'confirmation-ui' | 'ops';

const QUERY_TOOLS = ['customer.search', 'customer.get', 'credit.get', 'inventory.check', 'order.get', 'audit.trace', 'policy.get'];
const WRITE_TOOLS = [
  'order.preview_create',
  'order.execute_create',
  'order.preview_compensate',
  'order.execute_compensate',
];
const GOVERNANCE_TOOLS = ['confirmation.approve', 'confirmation.reject'];
const OPS_TOOLS = ['whitelist.list', 'whitelist.set', 'tenant.config.get'];

/**
 * Agent Runtime 物理上看不到 confirmation.approve——
 * 模型只能看到 needs_confirmation 状态和令牌，无法自己确认（公理 I4）。
 */
export function toolsForClient(kind: ClientKind): string[] {
  const tools = (() => {
    switch (kind) {
      case 'agent':
        return [...QUERY_TOOLS, ...WRITE_TOOLS];
      case 'confirmation-ui':
        return [...GOVERNANCE_TOOLS, 'customer.get', 'credit.get', 'inventory.check', 'order.get', 'audit.trace'];
      case 'ops':
        return [...QUERY_TOOLS, ...GOVERNANCE_TOOLS, ...OPS_TOOLS];
      default:
        return [];
    }
  })();
  return [...new Set(tools)];
}

/** §11.2 角色 → 工具 scope。 */
export function canCallTool(role: TenantRole, tool: string): boolean {
  const domain = tool.split('.')[0];
  const isQuery = tool.endsWith('.get') || tool.endsWith('.search') || tool.endsWith('.check') || tool.endsWith('.trace') || tool.endsWith('.list');

  switch (role) {
    case 'owner':
      return true;
    case 'sales':
      // 客户 / 订单 / 支付 / 库存的查询与写入
      return ['customer', 'order', 'payment', 'inventory', 'credit', 'product'].includes(domain);
    case 'finance':
      // 支付 / 额度 / 对账；不可修改客户档案
      if (domain === 'customer') return isQuery;
      return ['payment', 'credit', 'order', 'inventory'].includes(domain);
    case 'viewer':
      return isQuery;
    default:
      return false;
  }
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: TenantRole;
}

type Db = Pick<Prisma.TransactionClient, 'tenantMember' | 'user'>;

/**
 * 解析请求的租户上下文。
 *
 * 优先级：显式 membership > 用户归属租户。
 * 拿不到任何租户时直接拒绝——"猜一个默认租户"正是跨租户泄露的常见来源。
 */
export async function resolveTenantContext(
  userId: string,
  db: Db,
  preferredTenantId?: string,
): Promise<TenantContext> {
  const memberships = await db.tenantMember.findMany({ where: { userId } });

  if (preferredTenantId) {
    const match = memberships.find((m) => m.tenantId === preferredTenantId);
    if (!match) {
      throw new TefError('PERMISSION_DENIED', `user ${userId} is not a member of tenant ${preferredTenantId}`);
    }
    return { tenantId: match.tenantId, userId, role: match.role as TenantRole };
  }

  if (memberships.length > 0) {
    // 多租户成员时取角色最高的那个作为默认上下文；调用方可以显式指定。
    const best = memberships.reduce((a, b) => (ROLE_RANK[b.role] > ROLE_RANK[a.role] ? b : a));
    return { tenantId: best.tenantId, userId, role: best.role as TenantRole };
  }

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new TefError('PERMISSION_DENIED', `unknown user ${userId}`);
  }
  // 有归属租户但没有成员记录：按最小权限处理，而不是给 owner。
  return { tenantId: user.tenantId, userId, role: 'viewer' };
}

const ROLE_RANK: Record<string, number> = { viewer: 0, finance: 1, sales: 2, owner: 3 };

/** 租户风险阈值。缺键时由各调用方回落到自己的默认值。 */
export function toThresholdRecord(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
  }
  return out;
}

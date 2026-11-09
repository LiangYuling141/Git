import type { Prisma } from '@/generated/prisma';
import { TefError } from '@lymatrix/tef-core';
import type { ExecContext, TenantRole, WhitelistLevel } from '@lymatrix/tef-core';
import { toThresholdRecord, type ClientKind } from './tenant';
import type { PrismaTx } from './prisma';

/**
 * 调用方身份与执行上下文装配（L1 接入层 + L4 工具层）。
 *
 * 角色与租户由服务端解析，绝不接受模型声明（§11.2）。
 * timestampSnapshot 在这里取一次，之后 riskRules 只用这个快照——
 * 这是"纯函数 + 可复现评测"能成立的前提（§3.1）。
 */

export interface Principal {
  tenantId: string;
  userId: string;
  sessionId: string;
  role: TenantRole;
  /** 这个 client 能看到哪些工具，按身份注册而不是按文档约定（§6.4） */
  clientKind: ClientKind;
}

const RECENT_OP_WINDOW_MS = 5 * 60 * 1000;

type CtxDb = Pick<Prisma.TransactionClient, 'whitelistEntry' | 'tenant' | 'auditEvent'>;

export interface ExecContextOptions {
  traceId: string;
  now?: Date;
}

export async function buildExecContext(
  principal: Principal,
  db: CtxDb & PrismaTx,
  options: ExecContextOptions,
): Promise<ExecContext<PrismaTx>> {
  const now = options.now ?? new Date();

  const tenant = await db.tenant.findUnique({ where: { id: principal.tenantId } });
  if (!tenant) {
    throw new TefError('PERMISSION_DENIED', `tenant ${principal.tenantId} does not exist`);
  }
  if (tenant.status !== 'active') {
    throw new TefError('PERMISSION_DENIED', `tenant ${principal.tenantId} is ${tenant.status}`);
  }

  const whitelist = await db.whitelistEntry.findFirst({
    where: { userId: principal.userId, tenantId: principal.tenantId },
  });

  // 近期操作数只作为 riskRules 的输入因子，且是这里取好的快照，不是实时统计。
  const recentOpCount = await db.auditEvent.count({
    where: {
      tenantId: principal.tenantId,
      actorId: principal.userId,
      ts: { gte: new Date(now.getTime() - RECENT_OP_WINDOW_MS) },
    },
  });

  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    sessionId: principal.sessionId,
    role: principal.role,
    traceId: options.traceId,
    timestampSnapshot: now,
    recentOpCount,
    whitelistLevel: (whitelist?.level ?? 'none') as WhitelistLevel,
    tenantThresholds: toThresholdRecord(tenant.thresholds),
    db,
  };
}

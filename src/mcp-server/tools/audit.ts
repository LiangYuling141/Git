import { auditChain } from '@/tef/audit-chain';
import { canCallTool, toolsForClient } from '@/tef/tenant';
import { withTenantScope } from '@/tef/tenant-scope';
import { GENESIS_HASH } from '@/tef/hashing';
import type { Envelope } from '@/tef/types';
import { fail, ok } from '../envelope';
import type { Principal } from '../principal';

/**
 * 审计与策略工具。
 *
 * audit.trace 是"一切可回放"（公理 I6）的对外出口：给定 traceId，
 * 还原这次任务的输入、提议、校验、预览、确认、执行全过程，
 * 并同时给出哈希链的校验结论——回放内容和链完整性一起返回，
 * 这样"审计链完整"是一个可被调用方验证的结论，而不是一句声明。
 */

export async function auditTrace(principal: Principal, args: { traceId?: string }): Promise<Envelope> {
  if (!args.traceId) return fail('VALIDATION_ERROR', 'audit.trace requires traceId');

  return withTenantScope(principal.tenantId, async (tx) => {
    const [events, verification] = await Promise.all([
      auditChain.trace(args.traceId as string, principal.tenantId, tx),
      auditChain.verify(principal.tenantId, tx),
    ]);

    return ok(
      {
        traceId: args.traceId,
        events: events.map((event) => ({
          seq: event.seq,
          ts: event.ts,
          tool: event.tool,
          actorType: event.actorType,
          actorId: event.actorId,
          contract: event.contract || null,
          contractVersion: event.contractVersion || null,
          risk: event.risk,
          decision: event.decision,
          result: event.result,
          reasons: event.reasons,
          argsRedacted: event.argsRedacted,
          intentHash: event.intentHash,
          evidenceDigest: event.evidenceDigest,
          subjectRef: event.subjectRef,
          hash: undefined,
        })),
        chain: {
          ...verification,
          genesisHash: GENESIS_HASH,
        },
      },
      { risk: 'L0', reasons: ['read_only_query'], traceId: args.traceId },
    );
  });
}

/**
 * policy.get（知识工具）：返回租户阈值与本次调用的工具 scope。
 *
 * scope 由服务端计算后告知模型，方便它选择正确的工具；
 * 但强制校验发生在服务端，模型声明什么都不影响判定（§11.2）。
 */
export async function policyGet(principal: Principal): Promise<Envelope> {
  return withTenantScope(principal.tenantId, async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: principal.tenantId } });
    if (!tenant) return fail('NOT_FOUND', 'tenant not found');

    const visible = toolsForClient(principal.clientKind).filter((tool) => canCallTool(principal.role, tool));

    return ok({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        dataResidency: tenant.dataResidency,
        thresholds: tenant.thresholds,
        enabledPlugins: tenant.enabledPlugins,
      },
      principal: { role: principal.role, clientKind: principal.clientKind },
      visibleTools: visible,
      // 白名单只能调阈值，永不跳过 preview / 确认 / 幂等 / 审计（§3.3）
      whitelistBoundary: {
        allowed: ['提高金额阈值', '影响 recentOpCount 判定基准'],
        forbidden: ['跳过 preview', '跳过人工确认', '跳过幂等', '跳过审计'],
      },
      riskModel: {
        levels: ['L0', 'L1', 'L2', 'Block'],
        note: 'Block 是结果不是等级，优先级最高且不可被任何因子降级',
      },
    });
  });
}

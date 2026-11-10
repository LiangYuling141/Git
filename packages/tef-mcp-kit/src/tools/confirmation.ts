import { redactArgs } from '@lymtrix/tef-core';
import { TefError } from '@lymtrix/tef-core';
import type { Envelope } from '@lymtrix/tef-core';
import { auditChain } from '../audit-chain';
import { previewStore } from '../preview-store';
import { tokenStore } from '../token';
import { withTenantScope } from '../tenant-scope';
import { errorToEnvelope, fail, ok } from '../envelope';
import type { Principal } from '../principal';
import type { ContractWriteBaseOptions } from './contract';

/**
 * 治理工具（§6.4）。
 *
 * 这两个工具**不注册给 Agent Runtime**：模型只能看到 needs_confirmation 状态和令牌，
 * 物理上无法调用确认工具。可见性由 client 身份决定，不是靠提示词约定。
 *
 * 确认页必须展示服务端 diff 与证据原文，所以这里把快照里的 diff 原样返回，
 * 不用模型摘要替代——那是"确认疲劳"最主要的成因（§9.5 风险登记）。
 */

export async function confirmationApprove(
  principal: Principal,
  args: { confirmation_token?: string },
  options: ContractWriteBaseOptions,
): Promise<Envelope> {
  if (!args.confirmation_token) {
    return fail('VALIDATION_ERROR', 'confirmation.approve requires confirmation_token');
  }
  const now = options.now ?? new Date();

  try {
    return await withTenantScope(principal.tenantId, async (tx) => {
      const stored = await tokenStore.approve(args.confirmation_token as string, principal.userId, tx, options.secret, now);
      const snapshot = await previewStore.load(principal.tenantId, stored.claims.previewId, tx);
      if (!snapshot) {
        throw new TefError('CONFLICT', 'the preview snapshot behind this token no longer exists');
      }

      const appended = await auditChain.append(
        {
          traceId: snapshot.traceId || options.traceId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          actorType: 'human',
          tool: 'confirmation.approve',
          contract: snapshot.contract,
          contractVersion: snapshot.contractVersion,
          intentHash: snapshot.intentHash,
          argsRedacted: redactArgs(snapshot.normalizedArgs),
          evidenceDigest: snapshot.evidenceDigest,
          risk: snapshot.risk,
          reasons: snapshot.reasons,
          decision: 'allow',
          result: 'success',
          subjectRef: null,
        },
        tx,
        now,
      );

      return ok(
        {
          approved: true,
          previewId: snapshot.previewId,
          contract: snapshot.contract,
          contractVersion: snapshot.contractVersion,
          approver: principal.userId,
        },
        {
          risk: snapshot.risk,
          reasons: snapshot.reasons,
          // 服务端 diff 与证据原样回传，供确认页与审计回放使用
          diff: snapshot.diff,
          evidence: snapshot.evidence,
          auditId: appended.eventId,
          traceId: snapshot.traceId,
        },
      );
    });
  } catch (error) {
    return errorToEnvelope(error);
  }
}

export async function confirmationReject(
  principal: Principal,
  args: { confirmation_token?: string; reason?: string },
  options: ContractWriteBaseOptions,
): Promise<Envelope> {
  if (!args.confirmation_token) {
    return fail('VALIDATION_ERROR', 'confirmation.reject requires confirmation_token');
  }
  const now = options.now ?? new Date();

  try {
    return await withTenantScope(principal.tenantId, async (tx) => {
      const stored = await tokenStore.reject(args.confirmation_token as string, principal.userId, tx, options.secret, now);
      const snapshot = await previewStore.load(principal.tenantId, stored.claims.previewId, tx);

      // 作废快照：被拒绝的预览不能被换一个令牌重新执行（§12.2 的精神）
      if (snapshot) {
        await previewStore.revoke(principal.tenantId, stored.claims.previewId, tx);
      }

      const appended = await auditChain.append(
        {
          traceId: snapshot?.traceId || options.traceId,
          tenantId: principal.tenantId,
          actorId: principal.userId,
          actorType: 'human',
          tool: 'confirmation.reject',
          contract: snapshot?.contract ?? '',
          contractVersion: snapshot?.contractVersion ?? '',
          intentHash: snapshot?.intentHash ?? '',
          argsRedacted: snapshot ? redactArgs(snapshot.normalizedArgs) : {},
          evidenceDigest: snapshot?.evidenceDigest ?? '',
          risk: snapshot?.risk ?? 'Block',
          reasons: [...(snapshot?.reasons ?? []), args.reason ? `human_rejected: ${args.reason}` : 'human_rejected'],
          decision: 'reject',
          result: 'failure',
          subjectRef: null,
        },
        tx,
        now,
      );

      return ok(
        { rejected: true, previewId: stored.claims.previewId, reason: args.reason ?? null, rejectedBy: principal.userId },
        { risk: snapshot?.risk, auditId: appended.eventId, traceId: snapshot?.traceId },
      );
    });
  } catch (error) {
    return errorToEnvelope(error);
  }
}

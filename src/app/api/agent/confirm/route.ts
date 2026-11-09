import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { connectTefClient } from '@/mcp-server';
import { prisma } from '@/lib/prisma';
import { taskStateStore } from '@/tef/task-state';
import { resolveTenantContext } from '@/tef/tenant';
import { loadTokenSecret } from '@/tef/token';
import type { Envelope, TenantRole } from '@/tef/types';
import {
  EXECUTION_PENDING_REPLY,
  resolveConfirmationOutcome,
  resolveExecutionPlan,
} from './execute-plan';

/**
 * 人工确认入口（治理工具 + 确认后的执行）。
 *
 * 这个路由构造的 principal 是 clientKind='confirmation-ui'，
 * 所以它拿到的 MCP server 里注册了 confirmation.approve；
 * /api/agent 构造的是 clientKind='agent'，那里根本没有这个工具。
 * 隔离发生在工具注册表，不是提示词约定（§6.4）。
 *
 * 批准之后由服务端用 agent client 执行写入，并复用 TaskState 里持久化的
 * 幂等键（§4.4）——人在批准前后可能隔了很久，重试也必须只写一次。
 */

const APPROVER_ROLES: TenantRole[] = ['owner'];

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('sessionId')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'unauthorized', message: '请先登录' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({ where: { id: sessionCookie } });
  if (!session || (session.expiresAt && session.expiresAt < new Date())) {
    return NextResponse.json({ error: 'unauthorized', message: '会话已过期，请重新登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    confirmationToken?: string;
    action?: 'approve' | 'reject';
    reason?: string;
    conversationId?: string;
  } | null;

  const token = body?.confirmationToken;
  const action = body?.action;
  if (!token || (action !== 'approve' && action !== 'reject')) {
    return NextResponse.json(
      { error: 'validation', message: '需要 confirmationToken 与 action(approve|reject)' },
      { status: 400 },
    );
  }

  const tenant = await resolveTenantContext(session.userId, prisma, session.tenantId);
  const conversationId = body.conversationId || `conv_${session.userId}`;

  // 义乌场景是"老板本人做决策"。Phase 0 把批准权收敛到 owner：
  // 发起人（sales）与批准人不应该是同一个角色，否则确认只是走个形式。
  if (action === 'approve' && !APPROVER_ROLES.includes(tenant.role)) {
    return NextResponse.json(
      { error: 'forbidden', message: `角色 ${tenant.role} 无权批准；需要 ${APPROVER_ROLES.join(' 或 ')}` },
      { status: 403 },
    );
  }

  const secret = loadTokenSecret();
  const humanPrincipal = {
    tenantId: tenant.tenantId,
    userId: session.userId,
    sessionId: session.id,
    role: tenant.role,
    clientKind: 'confirmation-ui' as const,
  };

  // 必须在 confirmation.approve 之前读 TaskState：若上一笔执行结果未结算，
  // 这次请求是同一操作的重试，而原令牌可能已经被 Phase 1 消费。再调用
  // confirmation.approve 会得到 CONFLICT，把可恢复的 unknown 变成确定失败。
  const state = await taskStateStore.load(tenant.tenantId, conversationId);
  const unresolvedAttemptId = state?.pendingExecutionAttemptId ?? null;

  // 未结算执行期间拒绝不会撤销已经可能发生的副作用，也不能清掉 marker；
  // 保留现场并提示等待对账，避免下一次重试换 key 造成第二次副作用。
  if (unresolvedAttemptId && action === 'reject') {
    return NextResponse.json({
      status: 'executing',
      approved: false,
      reply: EXECUTION_PENDING_REPLY,
      traceId: state?.traceId ?? null,
    });
  }

  let decision: Envelope | null = null;
  let traceId: string;

  if (unresolvedAttemptId) {
    // 跳过人工批准：Phase 1 先检查 attempt 再消费令牌，已使用/已批准的
    // 令牌不会被二次消费；对账已结算时会直接重放已存结果。
    traceId = state?.traceId ?? `tr_exec_${Date.now()}`;
  } else {
    const human = await connectTefClient({ principal: humanPrincipal, traceId: `tr_confirm_${Date.now()}`, secret });
    try {
      decision = await human.callTool(action === 'approve' ? 'confirmation.approve' : 'confirmation.reject', {
        confirmation_token: token,
        ...(body.reason ? { reason: body.reason } : {}),
      });
    } finally {
      await human.close();
    }

    if (decision.status !== 'ok') {
      return NextResponse.json({
        status: 'failed',
        approved: false,
        reply: decision.error?.message ?? '确认失败',
        error: decision.error,
        traceId: decision.traceId,
      });
    }

    // 批准通过：traceId 沿用预览那一条，让预览、批准、执行落在同一条决策链上。
    traceId = decision.traceId ?? `tr_exec_${Date.now()}`;
  }

  if (action === 'reject') {
    const rejected = decision as Envelope;
    if (state) {
      await taskStateStore
        .update(
          tenant.tenantId,
          conversationId,
          {
            status: 'failed',
            pendingPreviewId: null,
            pendingIntentHash: null,
            pendingContract: null,
            pendingContractVersion: null,
            pendingExpiresAt: null,
            intent: null,
            idempotencyKey: null,
            pendingExecutionAttemptId: null,
          },
          state.version,
        )
        .catch(() => null);
    }

    return NextResponse.json({
      status: 'failed',
      approved: false,
      reply: '已拒绝。预览快照与令牌均已作废，如需继续请重新发起。',
      diff: rejected.diff,
      traceId: rejected.traceId,
      auditId: rejected.auditId,
    });
  }

  const contractOperation =
    state?.pendingPreview?.contract ??
    (state?.intent?.kind === 'operation' ? state.intent.contract : undefined) ??
    'create_order';
  const plan = resolveExecutionPlan(contractOperation);

  // 重试必须沿用未结算尝试的 key；没有 key 就无法命中原 attempt，
  // 生成新 key 会绕过 Phase 1 的尝试检查，绝不能静默降级。
  if (unresolvedAttemptId && !state?.idempotencyKey) {
    return NextResponse.json(
      {
        status: 'executing',
        approved: true,
        reply: '执行结果待对账，但缺少幂等键，需人工对账后再试。',
        traceId,
      },
      { status: 409 },
    );
  }
  const idempotencyKey = state?.idempotencyKey ?? `idem_${Date.now()}`;

  const agent = await connectTefClient({
    principal: { ...humanPrincipal, clientKind: 'agent' },
    traceId,
    secret,
  });
  let executed: Envelope;
  try {
    executed = await agent.callTool(plan.tool, {
      confirmation_token: token,
      idempotency_key: idempotencyKey,
    });
  } finally {
    await agent.close();
  }

  const outcome = resolveConfirmationOutcome(executed, plan, contractOperation, idempotencyKey);
  if (state) {
    await taskStateStore
      .update(
        tenant.tenantId,
        conversationId,
        outcome.clearPending
          ? {
              status: outcome.nextStatus,
              pendingPreviewId: null,
              pendingIntentHash: null,
              pendingContract: null,
              pendingContractVersion: null,
              pendingExpiresAt: null,
              intent: null,
              activeOrderId: outcome.activeOrderId,
              // 确定结果后清空执行锚点，下一次操作必须拿到新 key。
              idempotencyKey: null,
              pendingExecutionAttemptId: null,
            }
          : // 执行结果待对账：推进状态并写入显式 marker，保留幂等键、pending
            // 预览与过期时间。用户下一步仍用同一确认操作重试，不重新预览。
            {
              status: outcome.nextStatus,
              idempotencyKey,
              pendingExecutionAttemptId: outcome.pendingExecutionAttemptId,
            },
        state.version,
      )
      .catch(() => null);
  }

  return NextResponse.json({
    status: outcome.nextStatus,
    approved: true,
    reply: outcome.reply,
    risk: executed.risk,
    reasons: executed.reasons,
    traceId: executed.traceId,
    auditId: executed.auditId,
    error: executed.error,
    data: executed.data,
  });
}

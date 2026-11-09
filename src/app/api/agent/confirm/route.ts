import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { connectTefClient } from '@/mcp-server';
import { prisma } from '@/lib/prisma';
import { taskStateStore } from '@/tef/task-state';
import { resolveTenantContext } from '@/tef/tenant';
import { loadTokenSecret } from '@/tef/token';
import type { Envelope, TenantRole } from '@/tef/types';
import { resolveConfirmationOutcome, resolveExecutionPlan } from './execute-plan';

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

  const human = await connectTefClient({ principal: humanPrincipal, traceId: `tr_confirm_${Date.now()}`, secret });
  let decision: Envelope;
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

  if (action === 'reject') {
    await taskStateStore
      .load(tenant.tenantId, conversationId)
      .then((state) =>
        state
          ? taskStateStore.update(
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
              },
              state.version,
            )
          : null,
      )
      .catch(() => null);

    return NextResponse.json({
      status: 'failed',
      approved: false,
      reply: '已拒绝。预览快照与令牌均已作废，如需继续请重新发起。',
      diff: decision.diff,
      traceId: decision.traceId,
      auditId: decision.auditId,
    });
  }

  // 批准通过：用 agent client 执行。traceId 沿用预览那一条，
  // 这样 audit.trace 能把预览、批准、执行串成同一条决策链。
  const traceId = decision.traceId ?? `tr_exec_${Date.now()}`;
  const state = await taskStateStore.load(tenant.tenantId, conversationId);
  const idempotencyKey = state?.idempotencyKey ?? `idem_${Date.now()}`;
  const contractOperation = state?.pendingPreview?.contract ?? 'create_order';
  const plan = resolveExecutionPlan(contractOperation);

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

  const outcome = resolveConfirmationOutcome(executed, plan, contractOperation);
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
            }
          : // 执行结果待对账：只推进状态并保留幂等键，pending 预览与过期时间
            // 必须原样保留。用户下一步仍用同一确认操作重试，不重新预览。
            { status: outcome.nextStatus, idempotencyKey },
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

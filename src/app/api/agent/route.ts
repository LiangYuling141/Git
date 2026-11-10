import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { runAgentTurn } from '@/agent-runtime/runtime';
import { prisma } from '@/lib/prisma';
import { connectTefClient } from '@/mcp-server';
import { taskStateStore } from '@/tef/task-state';
import { resolveTenantContext } from '@/tef/tenant';
import { loadTokenSecret } from '@/tef/token';
import type { TaskStatus, TenantRole } from '@/tef/types';

/**
 * Agent 入口（L1 接入层 → L2 会话层 → L3 意图层）。
 *
 * 认证与租户识别在这里完成，然后把序列化后的 TaskState 交给 Runtime。
 * Runtime 不持有数据库凭据（公理 I2），TaskState 的读写留在这一层。
 */

const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'compensated', 'compensation_failed'];

function isTaskInFlight(status: TaskStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

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

  const body = (await request.json().catch(() => null)) as { message?: string; userInput?: string; conversationId?: string } | null;
  const message = (body?.message ?? body?.userInput ?? '').toString().trim();
  if (!message) {
    return NextResponse.json({ error: 'validation', message: 'message 不能为空' }, { status: 400 });
  }

  const conversationId = body?.conversationId?.toString() || `conv_${session.userId}`;

  let tenant;
  try {
    tenant = await resolveTenantContext(session.userId, prisma, session.tenantId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '无法解析租户上下文';
    return NextResponse.json({ error: 'forbidden', message: errorMessage }, { status: 403 });
  }

  let secret: string;
  try {
    secret = loadTokenSecret();
  } catch (error) {
    return NextResponse.json(
      { error: 'misconfigured', message: error instanceof Error ? error.message : 'TEF_TOKEN_SECRET 未配置' },
      { status: 500 },
    );
  }

  const taskState = await taskStateStore.loadOrCreate(tenant.tenantId, conversationId, session.userId);

  // conversationId 来自请求体：同一租户内也不能复用别人的任务状态。
  // 否则可以用他人未结算的 token/key 继续写入，或读取他人的任务快照。
  if (taskState.userId !== session.userId) {
    return NextResponse.json({ error: 'forbidden', message: '该会话不属于当前用户' }, { status: 403 });
  }

  // trace 属于任务而不是轮次：澄清往返、预览、确认、执行要落在同一条链上，
  // 否则 audit.trace 回放不出完整的决策过程（公理 I6）。
  const traceId = isTaskInFlight(taskState.status) && taskState.traceId ? taskState.traceId : `tr_${randomUUID()}`;

  const result = await runAgentTurn({
    message,
    conversationId,
    principal: {
      tenantId: tenant.tenantId,
      userId: session.userId,
      sessionId: session.id,
      role: tenant.role as TenantRole,
    },
    taskState,
    traceId,
    secret,
    connectSession: connectTefClient,
  });

  try {
    await taskStateStore.update(tenant.tenantId, conversationId, { ...result.patch, traceId }, taskState.version);
  } catch (error) {
    // TaskState 更新失败不影响已经发生的判定：写入路径本身是幂等的，
    // 而把乐观锁冲突当成 500 抛给用户会掩盖真正的结果。但这一 patch 可能
    // 承载未结算执行的 marker/key/token，必须留下日志供对账排查。
    console.error('[agent] failed to persist task state', error);
  }

  const envelope = result.envelope;
  return NextResponse.json({
    status: result.status,
    reply: result.reply,
    traceId: result.traceId,
    toolCalls: result.toolCalls,
    intentSource: result.intentSource,
    risk: envelope?.risk,
    reasons: envelope?.reasons,
    diff: envelope?.diff,
    questions: result.questions,
    previewId: envelope?.previewId,
    confirmationToken: envelope?.confirmationToken,
    expiresAt: envelope?.expiresAt,
    auditId: envelope?.auditId,
    error: envelope?.error,
    data: envelope?.data,
  });
}

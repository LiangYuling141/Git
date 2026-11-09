import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verifyTokenString, type TokenClaims } from '@lymtrix/tef-mcp-kit/token';
import { connectTefClient } from '@/mcp-server';
import { prisma } from '@/lib/prisma';
import { taskStateStore, type TaskStatePatch } from '@/tef/task-state';
import { resolveTenantContext } from '@/tef/tenant';
import { loadTokenSecret } from '@/tef/token';
import type { Envelope, TaskState, TenantRole } from '@/tef/types';
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

/** 未结算执行可重试的契约白名单；工具名只能由 marker 的 intent 契约映射。 */
const EXECUTION_TOOLS: Record<string, 'order.execute_create' | 'order.execute_compensate'> = {
  create_order: 'order.execute_create',
  compensate_order: 'order.execute_compensate',
};

/**
 * 未结算执行的权威契约。
 *
 * marker 写入时 Runtime 会把当前操作的 intent 一并持久化；它才是重试时
 * “这笔未结算写入到底是什么操作”的事实源。`pendingPreview.contract` 可能是
 * 更早操作残留的旧快照，绝不能用来选择执行工具。
 */
function authoritativeUnresolvedContract(state: TaskState | null): string | null {
  const intent = state?.intent;
  if (!intent || intent.kind !== 'operation') return null;
  const contract = intent.contract;
  return typeof contract === 'string' && Object.hasOwn(EXECUTION_TOOLS, contract) ? contract : null;
}

/**
 * 读取并验签请求令牌声明，用于契约交叉校验与 marker 权威状态写入。
 *
 * 传入 epoch 时间是为了跳过过期检查：marker 重试可能使用已过期但已消费的
 * 令牌，Phase 1 会先查 attempt 再决定是否消费；令牌生命周期仍由工具层判定。
 * 签名无效或格式错误返回 null，调用方必须 fail closed。
 */
function requestTokenClaims(token: string, secret: string): TokenClaims | null {
  try {
    return verifyTokenString(token, secret, new Date(0));
  } catch {
    return null;
  }
}

/**
 * 当前待确认操作的契约。
 *
 * 新批准路径用它和请求令牌声明交叉校验：旧确认卡片（例如 compensate）
 * 不能在新预览（例如 create）之后驱动执行。intent 与预览同轮写入，
 * 是当前操作最完整的快照；缺失时才回退到 pending 预览。
 */
function currentOperationContract(state: TaskState | null): string | null {
  const intent = state?.intent;
  if (intent?.kind === 'operation' && typeof intent.contract === 'string' && intent.contract) {
    return intent.contract;
  }
  const previewContract = state?.pendingPreview?.contract;
  return typeof previewContract === 'string' && previewContract ? previewContract : null;
}

/**
 * 结果未知时 marker 的权威操作字段，必须与本次实际执行的令牌同源。
 *
 * 重试选择执行工具只认 marker 的 intent；若写入 marker 时沿用上一轮操作的
 * intent/pending 快照，令牌命名空间与工具就会错位。slots 只在与令牌契约
 * 一致时沿用当前状态，跨契约时丢弃，绝不携带其他操作的业务参数。
 */
function authoritativePendingPatch(claims: TokenClaims | null, state: TaskState | null): TaskStatePatch {
  if (!claims) return {};
  const sameContractIntent =
    state?.intent?.kind === 'operation' && state.intent.contract === claims.contract ? state.intent : null;
  return {
    intent: { kind: 'operation', contract: claims.contract, slots: sameContractIntent?.slots ?? {} },
    pendingPreviewId: claims.previewId || state?.pendingPreview?.previewId || null,
    pendingContract: claims.contract,
    pendingContractVersion: claims.contractVersion || null,
  };
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

  const body = (await request.json().catch(() => null)) as {
    confirmationToken?: string;
    action?: 'approve' | 'reject';
    reason?: string;
    conversationId?: string;
  } | null;

  const requestToken = body?.confirmationToken;
  const action = body?.action;
  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json(
      { error: 'validation', message: '需要 action(approve|reject)；重试未结算执行时 token 可选' },
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
  // conversationId 来自请求体：同一租户内也不能复用别人的任务状态，
  // 否则可以用他人未结算的 token/key 重放写入。
  if (state && state.userId !== session.userId) {
    return NextResponse.json({ error: 'forbidden', message: '该会话不属于当前用户' }, { status: 403 });
  }
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
  /** 本次执行使用的令牌：重试时优先请求体，其次服务端持久化值。 */
  let executionToken: string;
  /** 本次执行应调用的契约；未结算重试只认 marker 的 intent。 */
  let contractOperation: string;
  /** 新批准路径验签后的请求令牌声明；marker 重试不依赖它。 */
  let requestClaims: TokenClaims | null = null;

  if (unresolvedAttemptId) {
    // 跳过人工批准：Phase 1 先检查 attempt 再消费令牌，已使用/已批准的
    // 令牌不会被二次消费；对账已结算时会直接重放已存结果。
    // 令牌是服务端重试状态，绝不再调用 confirmation.approve。
    const authoritative = authoritativeUnresolvedContract(state);
    if (!authoritative) {
      return NextResponse.json(
        {
          status: 'executing',
          approved: true,
          reply: '执行结果待对账，但无法确定原操作契约，需人工对账后再试。',
          traceId: state?.traceId ?? null,
        },
        { status: 409 },
      );
    }

    // 纵深防御：请求/服务端令牌声明的契约必须与 marker 的权威契约一致。
    // 不能用旧快照或跨操作令牌把写入送进错误的幂等命名空间。
    const candidateToken = requestToken || state?.pendingConfirmationToken || null;
    if (candidateToken) {
      const claimed = requestTokenClaims(candidateToken, secret)?.contract ?? null;
      if (claimed && claimed !== authoritative) {
        return NextResponse.json(
          {
            status: 'executing',
            approved: true,
            reply: '执行结果待对账，但请求令牌与原操作契约不一致，需人工对账后再试。',
            traceId: state?.traceId ?? null,
          },
          { status: 409 },
        );
      }
    }

    // 空字符串令牌必须回退到服务端持久化值，而不是被 `??` 当成有效值。
    const storedToken = requestToken || state?.pendingConfirmationToken || null;
    if (!storedToken) {
      return NextResponse.json(
        {
          status: 'executing',
          approved: true,
          reply: '执行结果待对账，但缺少确认令牌，需人工对账后再试。',
          traceId: state?.traceId ?? null,
        },
        { status: 409 },
      );
    }
    contractOperation = authoritative;
    executionToken = storedToken;
    traceId = state?.traceId ?? `tr_exec_${Date.now()}`;
  } else {
    if (!requestToken) {
      return NextResponse.json({ error: 'validation', message: '需要 confirmationToken' }, { status: 400 });
    }
    executionToken = requestToken;

    if (action === 'approve') {
      // 新批准路径必须能验签：不可验签的令牌不能驱动执行命名空间。
      const claims = requestTokenClaims(requestToken, secret);
      if (!claims) {
        return NextResponse.json(
          {
            error: 'CONFLICT',
            message: '无法验证确认令牌，已阻止执行。请刷新确认页并使用当前预览重新确认。',
            traceId: state?.traceId ?? null,
          },
          { status: 409 },
        );
      }

      // 旧确认卡片可能在新预览之后才被点击：令牌契约与当前待确认操作不一致时，
      // 绝不能用旧令牌挑一个执行工具并写入 marker，否则 intent 与尝试会分属
      // 两个命名空间，重试要么死锁要么重复写入。
      const pendingContract = currentOperationContract(state);
      if (pendingContract && claims.contract !== pendingContract) {
        return NextResponse.json(
          {
            error: 'CONFLICT',
            message: `确认卡片已过期：令牌对应 ${claims.contract}，当前待确认操作是 ${pendingContract}。已阻止执行，请刷新确认页并使用当前预览。`,
            traceId: state?.traceId ?? null,
          },
          { status: 409 },
        );
      }

      // 工具名只能来自白名单；未知契约 fail closed，绝不能默认成 create_order。
      if (!Object.hasOwn(EXECUTION_TOOLS, claims.contract)) {
        return NextResponse.json(
          {
            error: 'CONFLICT',
            message: `无法识别的操作契约 ${claims.contract || '(空)'}，已阻止执行。请刷新确认页后重新发起。`,
            traceId: state?.traceId ?? null,
          },
          { status: 409 },
        );
      }

      requestClaims = claims;
      contractOperation = claims.contract;
    } else {
      // 拒绝不产生写入；契约只用于保持响应结构一致，不参与工具选择。
      contractOperation = requestTokenClaims(requestToken, secret)?.contract ?? currentOperationContract(state) ?? '';
    }

    const human = await connectTefClient({ principal: humanPrincipal, traceId: `tr_confirm_${Date.now()}`, secret });
    try {
      decision = await human.callTool(action === 'approve' ? 'confirmation.approve' : 'confirmation.reject', {
        confirmation_token: requestToken,
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
            pendingConfirmationToken: null,
          },
          state.version,
        )
        .catch((error) => {
          console.error('[confirm] failed to persist rejected task state', error);
          return null;
        });
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

  // 未知契约必须 fail closed：为不认识的契约默认选择 create_order 会把写入
  // 送进错误的幂等命名空间。正常情况下上面的白名单/权威 intent 已保证可达性。
  const plan = resolveExecutionPlan(contractOperation);
  if (!plan) {
    return NextResponse.json(
      {
        status: 'conflict',
        approved: false,
        error: 'CONFLICT',
        message: `无法识别操作契约 ${contractOperation || '(空)'}，已阻止执行。请刷新确认页后重新发起。`,
        traceId,
      },
      { status: 409 },
    );
  }

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
  const attemptId = unresolvedAttemptId ?? `pending:${idempotencyKey}`;

  /**
   * 保留现场的非终结响应。
   *
   * 连接/调用异常与重试冲突都不能证明原 attempt 已失败：清 marker 或换 key
   * 会让下一次重新预览绕过 Phase 1 的尝试检查，可能产生第二次副作用。
   */
  async function keepUnresolved(
    reply: string,
    statusCode: number,
    extra: Record<string, unknown> = {},
  ): Promise<NextResponse> {
    if (state) {
      await taskStateStore
        .update(
          tenant.tenantId,
          conversationId,
          {
            status: 'executing',
            idempotencyKey,
            pendingExecutionAttemptId: attemptId,
            pendingConfirmationToken: executionToken,
            // 新批准路径：marker 的 intent/pending 必须与本次实际执行的令牌同源。
            // marker 重试：这些字段在首次写入 marker 时已经持久化，保持不动。
            ...(unresolvedAttemptId ? {} : authoritativePendingPatch(requestClaims, state)),
          },
          state.version,
        )
        .catch((error) => {
          console.error('[confirm] failed to persist unresolved execution state', error);
          return null;
        });
    }
    return NextResponse.json(
      { status: 'executing', approved: true, reply, traceId, ...extra },
      { status: statusCode },
    );
  }

  let agent: Awaited<ReturnType<typeof connectTefClient>>;
  try {
    agent = await connectTefClient({
      principal: { ...humanPrincipal, clientKind: 'agent' },
      traceId,
      secret,
    });
  } catch (error) {
    console.error('[confirm] failed to connect execution client', error);
    return keepUnresolved(
      '执行结果待对账：暂时无法连接执行服务，尚未确认是否已写入。请稍后使用同一确认操作重试；不要重新预览。',
      409,
    );
  }

  let executed: Envelope;
  try {
    try {
      executed = await agent.callTool(plan.tool, {
        confirmation_token: executionToken,
        idempotency_key: idempotencyKey,
      });
    } finally {
      await agent.close();
    }
  } catch (error) {
    console.error('[confirm] execution transport failed', error);
    return keepUnresolved(
      '执行结果待对账：执行服务调用中断，无法确认是否已写入。请稍后使用同一确认操作重试；不要重新预览。',
      409,
    );
  }

  // 未结算重试返回 CONFLICT：不能据此断言原 attempt 已失败，也不能清空
  // marker/key/token。保持非终结状态等待对账或人工处理。
  if (unresolvedAttemptId && executed.status === 'conflict') {
    return keepUnresolved(
      '执行结果待对账：重试返回冲突，但不能确认原尝试已经失败。请等待对账或人工处理；不要重新预览。',
      200,
      {
        risk: executed.risk,
        reasons: executed.reasons,
        auditId: executed.auditId,
        error: executed.error,
      },
    );
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
              pendingConfirmationToken: null,
            }
          : // 执行结果待对账：推进状态并写入显式 marker，保留幂等键、令牌、
            // pending 预览与过期时间。用户下一步仍用同一确认操作重试，
            // 服务端直接复用该令牌执行，绝不重新预览。
            {
              status: outcome.nextStatus,
              idempotencyKey,
              pendingExecutionAttemptId: outcome.pendingExecutionAttemptId,
              pendingConfirmationToken: executionToken,
              // 新批准路径写入令牌声明的权威 intent/pending；marker 重试沿用
              // 已持久化的权威字段，不能被请求体里的其他令牌改写。
              ...(unresolvedAttemptId ? {} : authoritativePendingPatch(requestClaims, state)),
            },
        state.version,
      )
      .catch((error) => {
        console.error('[confirm] failed to persist unresolved execution state', error);
        return null;
      });
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

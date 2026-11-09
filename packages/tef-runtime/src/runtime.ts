import { randomUUID } from 'node:crypto';
import type {
  ClarifyQuestion,
  Envelope,
  ErrorCode,
  IntentResult,
  TaskState,
  TaskStatus,
  TenantRole,
} from '@lymtrix/tef-core';
import type { TefClientSession } from '@lymtrix/tef-mcp-kit';
import { parseIntent } from './intent';
import type { TaskStatePatch } from './task-state';

/**
 * 最小 Agent Runtime（L2/L3）。
 *
 * 公理 I2：这个模块不 import Prisma、不 import BusinessEngine、也不碰令牌与快照存储。
 * 它唯一的对外能力是一个 MCP client——业务数据只能通过注册过的工具拿到。
 *
 * TaskState 的持久化在调用方（API 路由，属 L2 会话层）完成：
 * 本模块只接收序列化后的 TaskState、返回一个 patch。
 *
 * 会话连接器由调用方注入（connectSession），运行时包不反向依赖应用或垂直包；
 * 换一个垂直实现只需要换注入的 connector。
 */

export interface RuntimePrincipal {
  tenantId: string;
  userId: string;
  sessionId: string;
  role: TenantRole;
}

export type ConnectSession = (options: {
  principal: RuntimePrincipal & { clientKind: 'agent' };
  traceId: string;
  secret: string;
}) => Promise<TefClientSession>;

export interface AgentTurnInput {
  message: string;
  conversationId: string;
  principal: RuntimePrincipal;
  taskState: TaskState;
  traceId: string;
  secret: string;
  connectSession: ConnectSession;
}

export interface ToolCallRecord {
  tool: string;
  status: string;
  risk?: string;
}

export interface AgentTurnResult {
  status: TaskStatus;
  reply: string;
  patch: TaskStatePatch;
  envelope?: Envelope;
  questions?: ClarifyQuestion[];
  traceId: string;
  toolCalls: ToolCallRecord[];
  intentSource: 'model' | 'deterministic';
}

interface OrderSlots {
  customerId?: string;
  customerName?: string;
  productTerm?: string;
  sku?: string;
  quantity?: number;
  unitPrice?: number;
  depositRate?: number;
  termsDays?: number;
  // 让它可以直接作为澄清快照存进 TaskState.intent.slots
  [key: string]: unknown;
}

const ORDINALS: Record<string, number> = {
  '1': 0, '2': 1, '3': 2, '4': 3,
  第一: 0, 第二个: 1, 第三: 2, 第一个: 0, 首家: 0, 前者: 0, 后者: 1,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function envelopeData(envelope: Envelope): Record<string, unknown> {
  return asRecord(envelope.data);
}

const EXECUTION_PENDING_CODES: ReadonlySet<ErrorCode> = new Set([
  'EXECUTION_IN_PROGRESS',
  'EXECUTION_UNKNOWN',
]);

/**
 * 只有存在未结算执行时，旧幂等键才是重试锚点。
 *
 * 这里刻意不参考 TaskState.status：状态会在普通聊天/澄清轮次之间变化，
 * 用状态判断会让“完成 → 聊天 → 新订单”复用上一单的 key 并命中 Phase 1 重放。
 * 显式的 pendingExecutionAttemptId 才代表“副作用可能已发生，必须同 key 重试”。
 */
function unresolvedIdempotencyKey(taskState: TaskState): string | undefined {
  if (!taskState.pendingExecutionAttemptId) return undefined;
  return taskState.idempotencyKey ?? undefined;
}

/** 未结算执行对应的操作契约与可重放槽位；没有则返回 null。 */
function unresolvedOperationIntent(
  taskState: TaskState,
): Extract<IntentResult, { kind: 'operation' }> | null {
  if (!taskState.pendingExecutionAttemptId) return null;
  const intent = taskState.intent;
  return intent?.kind === 'operation' && intent.contract ? intent : null;
}

/**
 * marker 重试可执行的契约白名单。
 *
 * 工具名只能由这里的契约映射决定。绝不能从 `pendingPreview.contract` 推断：
 * 旧快照可能属于更早的操作（历史上 pending 字段优先保留已有预览），把 create
 * 令牌发到 compensate 工具会进入错误的幂等命名空间，甚至产生第二次副作用。
 */
const EXECUTION_TOOLS: Record<string, string> = {
  create_order: 'order.execute_create',
  compensate_order: 'order.execute_compensate',
};

function isExecutableContract(contract: string | undefined | null): boolean {
  return typeof contract === 'string' && Object.hasOwn(EXECUTION_TOOLS, contract);
}

/**
 * 契约 → 执行工具名。
 *
 * 用 `Object.hasOwn` 而不是直接下标：`EXECUTION_TOOLS['constructor']` 会返回
 * Object 构造函数这类原型成员，把它当成工具名会绕过白名单。未知契约返回 null。
 */
export function executionToolFor(contract: string): string | null {
  return Object.hasOwn(EXECUTION_TOOLS, contract) ? EXECUTION_TOOLS[contract] : null;
}

/**
 * 单次执行使用的幂等键。
 *
 * 只有未结算标记存在时才复用旧 key；其余情况一律生成新 key
 * （新操作不能复用上一单的幂等记录）。
 */
function idempotencyKeyFor(taskState: TaskState): string {
  return unresolvedIdempotencyKey(taskState) ?? randomUUID();
}

/**
 * 待对账时显式保留 pending 字段。
 *
 * 本轮产生了执行令牌时，pending 快照必须来自**这份预览**：`pendingPreviewId`、
 * `pendingContract`、`pendingContractVersion`、`pendingExpiresAt` 与令牌同源。
 * 若沿用 TaskState 里已有的旧快照，marker 会携带“新 token + 旧契约”，下一次
 * 重试就可能把 create 令牌发给 compensate 工具。
 *
 * 没有新预览时（marker 重试、缺少 key/token 的早退路径）才原样写回已有快照，
 * 保证“未知结果不清 pending”是显式契约而不是存储实现细节。
 */
function pendingFields(
  taskState: TaskState,
  operationIntent: IntentResult | null,
  preview?: Envelope,
): TaskStatePatch {
  // 服务端重试令牌：本轮预览产生了新令牌就用新的，否则沿用已持久化的令牌。
  // 该字段只用于服务端同 token 重试，绝不下发给模型。
  const pendingConfirmationToken = preview?.confirmationToken ?? taskState.pendingConfirmationToken ?? null;
  if (preview?.previewId) {
    return {
      pendingPreviewId: preview.previewId,
      pendingIntentHash: '',
      pendingContract: operationIntent?.kind === 'operation' ? operationIntent.contract : '',
      pendingContractVersion: '1.0',
      pendingExpiresAt: preview.expiresAt ? new Date(preview.expiresAt) : null,
      pendingConfirmationToken,
    };
  }
  const pending = taskState.pendingPreview;
  if (pending) {
    return {
      pendingPreviewId: pending.previewId,
      pendingIntentHash: pending.intentHash,
      pendingContract: pending.contract,
      pendingContractVersion: pending.contractVersion,
      pendingExpiresAt: pending.expiresAt,
      pendingConfirmationToken,
    };
  }
  return {};
}

/**
 * 结果确定（成功/冲突/确定失败）后的清理补丁。
 *
 * 未结算标记与幂等键必须一起清空：任务进入终结状态后它们只是历史，
 * 留着会让下一轮新操作误命中上一单的幂等记录。
 */
function clearedExecutionFields(): TaskStatePatch {
  return {
    idempotencyKey: null,
    pendingExecutionAttemptId: null,
    pendingConfirmationToken: null,
    intent: null,
    pendingPreviewId: null,
    pendingIntentHash: null,
    pendingContract: null,
    pendingContractVersion: null,
    pendingExpiresAt: null,
  };
}

interface ExecutionReportMeta {
  taskState: TaskState;
  traceId: string;
  toolCalls: ToolCallRecord[];
  intentSource: 'model' | 'deterministic';
  /** 当前操作契约与可重放槽位；未知结果时必须写回 TaskState 供同操作重试。 */
  operationIntent?: IntentResult | null;
  /** 本轮产生执行令牌的预览信封；首次执行时用于补齐 pending 字段。 */
  preview?: Envelope;
}

/**
 * 执行结果未知时的统一出口。
 *
 * 执行层已用 EXECUTION_IN_PROGRESS / EXECUTION_UNKNOWN 明确标注“副作用可能
 * 已经发生”。Runtime 必须保留幂等键、pending 状态与可重放意图，并写入
 * pendingExecutionAttemptId，提示用户用同一操作重试；若清掉 pending 并生成
 * 新 key，下一次执行会绕过原来的 attempt，产生第二次副作用。
 */
function executionPendingResult(
  executed: Envelope,
  idempotencyKey: string,
  meta: ExecutionReportMeta,
): AgentTurnResult | null {
  const code = executed.error?.code;
  if (!code || !EXECUTION_PENDING_CODES.has(code)) return null;
  const data = envelopeData(executed);
  const attemptId =
    typeof data.attemptId === 'string' && data.attemptId
      ? data.attemptId
      : `pending:${idempotencyKey}`;
  const operationIntent = meta.operationIntent ?? null;
  return finish(
    'executing',
    '执行结果待对账，请稍后使用同一操作重试；不要重新预览。',
    {
      idempotencyKey,
      pendingExecutionAttemptId: attemptId,
      ...pendingFields(meta.taskState, operationIntent, meta.preview),
      ...(operationIntent ? { intent: operationIntent } : {}),
    },
    { ...meta, envelope: executed },
  );
}

/**
 * 澄清回填（§7.3）。用户可以用序号、也可以用更完整的名称来消歧。
 * 只回填槽位，不重新猜测其它字段。
 */
function resolveClarification(taskState: TaskState, message: string): { intent: IntentResult; slots: OrderSlots } | null {
  const intent = taskState.intent;
  if (!intent || intent.kind !== 'clarify') return null;

  const text = message.trim();
  const base: OrderSlots = { ...((intent.slots ?? {}) as OrderSlots) };
  const normalized = text.replace(/[个吧啊。！!]/g, '');

  for (const question of intent.questions) {
    // 订单号没有候选列表，用户回答什么就是什么；由契约在执行前校验。
    if (question.slot === 'orderNo') {
      if (text) base.orderNo = text;
      continue;
    }
    if (question.slot === 'orderId') {
      if (text) base.orderId = text;
      continue;
    }

    const candidates = question.candidates ?? [];
    const ordinal = ORDINALS[text] ?? ORDINALS[normalized];
    const picked =
      ordinal !== undefined && candidates[ordinal]
        ? candidates[ordinal]
        : candidates.find((candidate) => text.includes(candidate.label) || candidate.label.includes(text));
    if (!picked) continue;

    if (question.slot === 'customerId') {
      base.customerId = picked.id;
      delete base.customerName;
    }
    if (question.slot === 'sku') {
      // 候选 id 放的是 SKU 字符串，不是商品主键
      base.sku = picked.id;
      delete base.productTerm;
    }
  }

  return {
    intent: {
      kind: 'operation',
      contract: intent.contract ?? 'create_order',
      slots: base as Record<string, unknown>,
    },
    slots: base,
  };
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const { principal, traceId, secret, taskState } = input;
  const toolCalls: ToolCallRecord[] = [];

  // 0. 未结算执行优先：副作用可能已经发生，本轮禁止解析新意图或换 key。
  // 没有可重放的操作快照时只能提示等待对账，不能把它当成一轮普通聊天。
  const unresolvedIntent = unresolvedOperationIntent(taskState);
  if (taskState.pendingExecutionAttemptId) {
    if (!taskState.idempotencyKey) {
      // 没有 key 就无法命中原 attempt；生成新 key 会绕过 Phase 1 检查，
      // 可能产生第二次副作用。这里只能要求人工对账，绝不静默降级。
      return finish(
        'executing',
        '上一笔执行结果待对账，但缺少幂等键，需人工对账后再试。',
        {
          idempotencyKey: null,
          pendingExecutionAttemptId: taskState.pendingExecutionAttemptId,
          ...pendingFields(taskState, unresolvedIntent),
          ...(unresolvedIntent ? { intent: unresolvedIntent } : {}),
        },
        { traceId, toolCalls, intentSource: 'deterministic' },
      );
    }
    if (!unresolvedIntent) {
      return finish(
        'executing',
        '上一笔执行结果待对账，请稍后重试或等待对账完成。',
        {
          idempotencyKey: taskState.idempotencyKey,
          pendingExecutionAttemptId: taskState.pendingExecutionAttemptId,
          ...pendingFields(taskState, null),
        },
        { traceId, toolCalls, intentSource: 'deterministic' },
      );
    }

    // 直接重试需要三件服务端状态：同 key、同令牌、可重放的契约。
    // 缺少任何一项都不能重新预览或新开操作——原 attempt 仍可能在对账中提交。
    if (!taskState.pendingConfirmationToken) {
      return finish(
        'executing',
        '上一笔执行结果待对账，但缺少确认令牌，需人工对账后再试。',
        {
          idempotencyKey: taskState.idempotencyKey,
          pendingExecutionAttemptId: taskState.pendingExecutionAttemptId,
          ...pendingFields(taskState, unresolvedIntent),
          intent: unresolvedIntent,
        },
        { traceId, toolCalls, intentSource: 'deterministic' },
      );
    }
    // 契约只认与 marker 一起持久化的 intent。pendingPreview 可能是更早操作的
    // 残留快照，用它选工具会把令牌发进错误的幂等命名空间。
    if (!isExecutableContract(unresolvedIntent.contract)) {
      return finish(
        'executing',
        '上一笔执行结果待对账，但无法确定原操作契约，需人工对账后再试。',
        {
          idempotencyKey: taskState.idempotencyKey,
          pendingExecutionAttemptId: taskState.pendingExecutionAttemptId,
          ...pendingFields(taskState, unresolvedIntent),
          intent: unresolvedIntent,
        },
        { traceId, toolCalls, intentSource: 'deterministic' },
      );
    }

    return await retryUnresolvedExecution(input, taskState, unresolvedIntent, toolCalls);
  }

  const session = await input.connectSession({
    principal: { ...principal, clientKind: 'agent' },
    traceId,
    secret,
  });

  try {
    // 1. 澄清回填优先：上一轮问了什么，这一轮就在回答什么。
    // 未结算执行时跳过意图解析与澄清，直接用持久化的操作快照重试同一操作。
    const resumed =
      !unresolvedIntent && taskState.status === 'awaiting_clarification'
        ? resolveClarification(taskState, input.message)
        : null;

    let intent: IntentResult;
    let intentSource: 'model' | 'deterministic';
    if (unresolvedIntent) {
      intent = unresolvedIntent;
      intentSource = 'deterministic';
    } else if (resumed) {
      intent = resumed.intent;
      intentSource = 'deterministic';
    } else {
      const parsed = await parseIntent(input.message);
      intent = parsed.intent;
      intentSource = parsed.source;
    }

    if (intent.kind === 'chat') {
      return finish('idle', intent.reply, {}, { traceId, toolCalls, intentSource });
    }

    if (intent.kind === 'clarify') {
      return askClarification(intent.questions, taskState, intentSource, traceId, toolCalls, intent.slots ?? {});
    }

    if (intent.kind === 'compound') {
      // §7.3：复合意图逐步执行、逐步确认，不合并事务。Phase 0 只做第一步。
      const first = intent.steps[0];
      if (!first) return finish('idle', '没有可执行的步骤。', {}, { traceId, toolCalls, intentSource });
      return finish(
        'idle',
        '复合意图将逐步执行。请先确认第一步。',
        { intent: first, status: 'intent_parsed' },
        { traceId, toolCalls, intentSource },
      );
    }

    const contract = intent.contract;
    if (contract === 'compensate_order') {
      return await handleCompensateOrder(session, intent.slots, {
        taskState,
        traceId,
        toolCalls,
        intentSource,
      });
    }
    if (contract === 'create_order') {
      return await handleCreateOrder(session, intent.slots as OrderSlots, {
        taskState,
        traceId,
        toolCalls,
        intentSource,
      });
    }
    return await handleQuery(session, contract, intent.slots, { traceId, toolCalls, intentSource, taskState });
  } finally {
    await session.close();
  }
}

/**
 * 未结算执行的保现场返回。
 *
 * 对账/人工处理路径绝不清空 marker、幂等键或令牌，也不生成新 key：
 * 原 attempt 仍可能已经提交副作用，清掉锚点会让下一次操作换 key 重放。
 */
function unresolvedRetryPending(
  taskState: TaskState,
  operationIntent: Extract<IntentResult, { kind: 'operation' }>,
  idempotencyKey: string,
  reply: string,
  meta: { traceId: string; toolCalls: ToolCallRecord[]; envelope?: Envelope },
): AgentTurnResult {
  return finish(
    'executing',
    reply,
    {
      idempotencyKey,
      pendingExecutionAttemptId: taskState.pendingExecutionAttemptId ?? `pending:${idempotencyKey}`,
      ...pendingFields(taskState, operationIntent),
      intent: operationIntent,
    },
    { ...meta, intentSource: 'deterministic' },
  );
}

/**
 * 未结算执行的直接重试。
 *
 * 使用持久化的确认令牌与幂等键调用原执行工具，绝不重新预览：重新预览会
 * 签发新令牌/新快照，而原 attempt 仍可能在对账中提交；预览若被阻断，还会
 * 让任务既保留 marker 又失去可重放意图。Phase 1 在消费令牌之前检查 attempt，
 * 因此已消费的令牌在 attempt 存在时是安全的。
 *
 * 工具名只由持久化 intent 的契约决定。连接/调用异常与确定性 CONFLICT 都不能
 * 证明原 attempt 已失败，必须保留现场等待对账，而不是返回 500 或清空 marker。
 */
async function retryUnresolvedExecution(
  input: AgentTurnInput,
  taskState: TaskState,
  unresolvedIntent: Extract<IntentResult, { kind: 'operation' }>,
  toolCalls: ToolCallRecord[],
): Promise<AgentTurnResult> {
  const contract = unresolvedIntent.contract;
  const tool = executionToolFor(contract);
  const idempotencyKey = taskState.idempotencyKey as string;
  const confirmationToken = taskState.pendingConfirmationToken as string;

  if (!tool) {
    return unresolvedRetryPending(
      taskState,
      unresolvedIntent,
      idempotencyKey,
      '上一笔执行结果待对账，但无法确定原操作契约，需人工对账后再试。',
      { traceId: input.traceId, toolCalls },
    );
  }

  let session: TefClientSession;
  try {
    session = await input.connectSession({
      principal: { ...input.principal, clientKind: 'agent' },
      traceId: input.traceId,
      secret: input.secret,
    });
  } catch {
    return unresolvedRetryPending(
      taskState,
      unresolvedIntent,
      idempotencyKey,
      '执行结果待对账：暂时无法连接执行服务，尚未确认是否已写入。请稍后使用同一操作重试；不要重新预览。',
      { traceId: input.traceId, toolCalls },
    );
  }

  try {
    let executed: Envelope;
    try {
      executed = await session.callTool(tool, {
        confirmation_token: confirmationToken,
        idempotency_key: idempotencyKey,
      });
    } catch {
      toolCalls.push({ tool, status: 'error' });
      return unresolvedRetryPending(
        taskState,
        unresolvedIntent,
        idempotencyKey,
        '执行结果待对账：执行服务调用中断，无法确认是否已写入。请稍后使用同一操作重试；不要重新预览。',
        { traceId: input.traceId, toolCalls },
      );
    }
    toolCalls.push({ tool, status: executed.status, risk: executed.risk });

    // 重试返回 CONFLICT 时不能断言原 attempt 已失败：可能是令牌/快照状态不一致，
    // 也可能是原写入已提交但结果记录缺失。清空 marker 会让后续重新预览换 key，
    // 从而可能产生第二次副作用。
    if (executed.status === 'conflict') {
      return unresolvedRetryPending(
        taskState,
        unresolvedIntent,
        idempotencyKey,
        '执行结果待对账：重试返回冲突，但不能确认原尝试已经失败。请等待对账或人工处理；不要重新预览。',
        { traceId: input.traceId, toolCalls, envelope: executed },
      );
    }

    const meta: ExecutionReportMeta = {
      taskState,
      traceId: input.traceId,
      toolCalls,
      intentSource: 'deterministic',
      operationIntent: unresolvedIntent,
    };
    return contract === 'compensate_order'
      ? reportCompensation(executed, idempotencyKey, meta)
      : reportExecution(executed, idempotencyKey, meta);
  } finally {
    await session.close();
  }
}

function finish(
  status: TaskStatus,
  reply: string,
  patch: TaskStatePatch,
  meta: { traceId: string; toolCalls: ToolCallRecord[]; intentSource: 'model' | 'deterministic'; envelope?: Envelope; questions?: ClarifyQuestion[] },
): AgentTurnResult {
  return { status, reply, patch: { ...patch, status }, envelope: meta.envelope, questions: meta.questions, traceId: meta.traceId, toolCalls: meta.toolCalls, intentSource: meta.intentSource };
}

function askClarification(
  questions: ClarifyQuestion[],
  taskState: TaskState,
  intentSource: 'model' | 'deterministic',
  traceId: string,
  toolCalls: ToolCallRecord[],
  partialSlots: Record<string, unknown> = {},
  contract?: string,
): AgentTurnResult {
  const rounds = taskState.clarificationRounds + 1;
  // §7.3：超过 3 轮就终止任务，不要无限追问
  if (rounds > 3) {
    return finish(
      'failed',
      '澄清超过 3 轮仍未确定，已终止本次任务。请换一种说法，或直接走人工录入。',
      { clarificationRounds: rounds, intent: null },
      { traceId, toolCalls, intentSource },
    );
  }
  const reply = questions
    .map((question) => {
      const lines = [`需要确认「${question.slot}」（${question.reason}）`];
      (question.candidates ?? []).forEach((candidate, index) => {
        lines.push(`  ${index + 1}. ${candidate.label} — ${candidate.matchReason}`);
      });
      return lines.join('\n');
    })
    .join('\n');

  // 连同已解析的槽位一起持久化（§7.3 的 intent 快照），用户回答后才能接着走
  const previousSlots = taskState.intent?.kind === 'clarify' ? (taskState.intent.slots ?? {}) : {};

  return finish(
    'awaiting_clarification',
    reply,
    {
      clarificationRounds: rounds,
      intent: {
        kind: 'clarify',
        ...(contract ? { contract } : {}),
        questions,
        slots: { ...previousSlots, ...partialSlots },
      },
    },
    { traceId, toolCalls, intentSource, questions },
  );
}

async function handleQuery(
  session: TefClientSession,
  contract: string,
  slots: Record<string, unknown>,
  meta: { traceId: string; toolCalls: ToolCallRecord[]; intentSource: 'model' | 'deterministic'; taskState: TaskState },
): Promise<AgentTurnResult> {
  const customerName = typeof slots.customerName === 'string' ? slots.customerName : undefined;

  if ((contract === 'credit.get' || contract === 'order.get') && customerName && !slots.customerId) {
    const resolved = await resolveCustomer(session, customerName, meta.toolCalls);
    if (resolved.kind === 'many')
      return askClarification(resolved.questions, meta.taskState, meta.intentSource, meta.traceId, meta.toolCalls, slots);
    if (resolved.kind === 'none') return finish('failed', `没有找到客户「${customerName}」。`, {}, meta);
    slots = { ...slots, customerId: resolved.customerId };
  }

  const tool =
    contract === 'credit.get'
      ? 'credit.get'
      : contract === 'inventory.check'
        ? 'inventory.check'
        : contract === 'order.get'
          ? 'order.get'
          : 'customer.search';

  const args =
    tool === 'credit.get' || tool === 'order.get'
      ? { customerId: slots.customerId }
      : tool === 'inventory.check'
        ? { sku: slots.productTerm }
        : { name: customerName };

  const envelope = await session.callTool(tool, args as Record<string, unknown>);
  meta.toolCalls.push({ tool, status: envelope.status, risk: envelope.risk });

  if (envelope.status !== 'ok') {
    return finish('failed', envelope.error?.message ?? '查询失败。', {}, { ...meta, envelope });
  }
  return finish('completed', JSON.stringify(envelope.data, null, 2), { status: 'completed' }, { ...meta, envelope });
}

/**
 * 企业名检索变体。
 *
 * 口语里说"伟业公司"，档案里存的是"义乌市伟业进出口有限公司"——
 * 直接子串匹配会一个都搜不到。所以按"去掉通用后缀 → 取核心字号"逐级放宽，
 * 直到搜出候选为止。放宽只影响召回，消歧仍然靠人工确认。
 */
const COMPANY_SUFFIXES = /(股份有限公司|有限责任公司|有限公司|公司|集团|商行|商贸|贸易|工厂|厂|店)$/;
const CITY_PREFIXES = /^(义乌市|义乌|金华市|金华|浙江省|浙江|中国)/;

function nameVariants(name: string): string[] {
  const variants = [name];
  let current = name;
  for (let step = 0; step < 3; step += 1) {
    const stripped = current.replace(COMPANY_SUFFIXES, '');
    if (stripped === current) break;
    current = stripped;
    if (current) variants.push(current);
  }
  const withoutCity = current.replace(CITY_PREFIXES, '');
  if (withoutCity && withoutCity !== current) variants.push(withoutCity);
  return [...new Set(variants.filter((variant) => variant.length >= 2))];
}

type ResolveResult =
  | { kind: 'one'; customerId: string; label: string }
  | { kind: 'many'; questions: ClarifyQuestion[] }
  | { kind: 'none' };

async function resolveCustomer(
  session: TefClientSession,
  customerName: string,
  toolCalls: ToolCallRecord[],
): Promise<ResolveResult> {
  let candidates: Array<{ id: string; label: string; matchReason: string }> = [];

  for (const variant of nameVariants(customerName)) {
    const envelope = await session.callTool('customer.search', { name: variant });
    toolCalls.push({ tool: 'customer.search', status: envelope.status, risk: envelope.risk });
    candidates = (envelopeData(envelope).candidates as Array<{ id: string; label: string; matchReason: string }>) ?? [];
    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'one', customerId: candidates[0].id, label: candidates[0].label };

  // 义乌商户重名极多：候选多于 1 时必须澄清，这是关键路径不是可选增强（§7.3）
  return {
    kind: 'many',
    questions: [{ slot: 'customerId', reason: 'ambiguous', candidates }],
  };
}

/**
 * 已提交订单的补偿路径。
 *
 * 订单定位优先级：显式 orderId → 订单号 → 当前任务上下文 → 追问。
 * 补偿本身仍然走 preview → L2 → 人工确认 → execute，Runtime 不直接写库。
 */
async function handleCompensateOrder(
  session: TefClientSession,
  slots: Record<string, unknown>,
  meta: ExecutionReportMeta,
): Promise<AgentTurnResult> {
  const reason = typeof slots.reason === 'string' ? slots.reason : undefined;
  let orderId = typeof slots.orderId === 'string' ? slots.orderId : undefined;
  const orderNo = typeof slots.orderNo === 'string' ? slots.orderNo : undefined;

  // 1. 订单定位：显式 ID → 订单号 → 当前任务上下文 → 追问
  if (!orderId && orderNo) {
    const lookup = await session.callTool('order.get', { orderNo });
    meta.toolCalls.push({ tool: 'order.get', status: lookup.status, risk: lookup.risk });
    if (lookup.status !== 'ok') {
      return finish('failed', `没有找到订单 ${orderNo}。`, {}, { ...meta, envelope: lookup });
    }
    orderId = envelopeData(lookup).id as string | undefined;
  }
  if (!orderId) orderId = meta.taskState.activeOrderId ?? undefined;
  if (!orderId) {
    return askClarification(
      [{ slot: 'orderNo', reason: 'missing' }],
      meta.taskState,
      meta.intentSource,
      meta.traceId,
      meta.toolCalls,
      { ...slots, ...(reason ? { reason } : {}) },
      'compensate_order',
    );
  }

  // 2. 预览补偿：前置条件、风险与副作用全部由契约判定
  const preview = await session.callTool('order.preview_compensate', {
    orderId,
    ...(reason ? { reason } : {}),
  });
  meta.toolCalls.push({ tool: 'order.preview_compensate', status: preview.status, risk: preview.risk });

  if (preview.status === 'blocked') {
    // 防御分支：有 marker 时主流程不会进入预览。若未来改动让这里可达，
    // 也绝不能清掉未结算标记，更不能声称"没有产生写入"——原 attempt
    // 仍可能已经提交副作用。
    if (meta.taskState.pendingExecutionAttemptId) {
      return finish(
        'executing',
        '本次预览被阻断，但上一笔执行结果仍未结算，无法断言没有写入；请等待对账并使用同一操作重试。',
        {
          idempotencyKey: meta.taskState.idempotencyKey ?? null,
          pendingExecutionAttemptId: meta.taskState.pendingExecutionAttemptId,
          ...pendingFields(meta.taskState, null),
        },
        { ...meta, envelope: preview },
      );
    }
    const lines = ['本次补偿被契约阻断，没有产生任何写入：', ...(preview.reasons ?? [])];
    (preview.error?.checks ?? []).forEach((check) => lines.push(`  · ${check.code} — ${check.message}`));
    return finish('failed', lines.join('\n'), { intent: null }, { ...meta, envelope: preview });
  }

  if (preview.status === 'needs_confirmation') {
    const diffLines = (preview.diff ?? []).map((entry) => `  · ${entry.label ?? `${entry.action} ${entry.entity}`}`);
    const reply = [
      `补偿风险等级 ${preview.risk}，需要人工确认。`,
      '判定依据：',
      ...(preview.reasons ?? []).map((item) => `  · ${item}`),
      '服务端计算出的变更（不是模型摘要）：',
      ...diffLines,
      '请在确认区批准或拒绝。批准前不会有任何写入。',
    ].join('\n');

    return finish(
      'awaiting_confirmation',
      reply,
      {
        intent: { kind: 'operation', contract: 'compensate_order', slots: { orderId, ...(reason ? { reason } : {}) } },
        pendingPreviewId: preview.previewId ?? null,
        pendingIntentHash: '',
        pendingContract: 'compensate_order',
        pendingContractVersion: '1.0',
        pendingExpiresAt: preview.expiresAt ? new Date(preview.expiresAt) : null,
        activeOrderId: orderId,
        // 重试路径沿用未结算执行的 key；新操作生成新 key。
        idempotencyKey: idempotencyKeyFor(meta.taskState),
        clarificationRounds: 0,
      },
      { ...meta, envelope: preview },
    );
  }

  // 补偿契约恒为 L2；这里保留防御分支，契约若降级也不至于静默不执行。
  if (preview.status === 'ok' && preview.confirmationToken) {
    const idempotencyKey = idempotencyKeyFor(meta.taskState);
    const executed = await session.callTool('order.execute_compensate', {
      confirmation_token: preview.confirmationToken,
      idempotency_key: idempotencyKey,
    });
    meta.toolCalls.push({ tool: 'order.execute_compensate', status: executed.status, risk: executed.risk });
    return reportCompensation(executed, idempotencyKey, {
      ...meta,
      operationIntent: { kind: 'operation', contract: 'compensate_order', slots: { orderId, ...(reason ? { reason } : {}) } },
      preview,
    });
  }

  return finish('failed', preview.error?.message ?? '补偿预览未成功。', {}, { ...meta, envelope: preview });
}

export function reportCompensation(
  executed: Envelope,
  idempotencyKey: string,
  meta: ExecutionReportMeta,
): AgentTurnResult {
  const pending = executionPendingResult(executed, idempotencyKey, meta);
  if (pending) return pending;

  if (executed.status === 'ok') {
    return finish(
      'compensated',
      '订单补偿已完成：订单已取消，收款计划已作废，库存与信用额度已恢复。',
      {
        ...clearedExecutionFields(),
        activeOrderId: (envelopeData(executed).orderId as string) ?? null,
      },
      { ...meta, envelope: executed },
    );
  }
  if (executed.status === 'conflict') {
    return finish(
      'conflict',
      `补偿执行冲突，未产生写入：${executed.error?.message ?? ''}\n需要重新预览；旧令牌已作废。`,
      clearedExecutionFields(),
      { ...meta, envelope: executed },
    );
  }
  return finish(
    'failed',
    executed.error?.message ?? '补偿执行失败。',
    clearedExecutionFields(),
    { ...meta, envelope: executed },
  );
}

async function handleCreateOrder(
  session: TefClientSession,
  slots: OrderSlots,
  meta: ExecutionReportMeta,
): Promise<AgentTurnResult> {
  let { customerId, sku } = slots;

  // 2. 客户消歧
  if (!customerId && slots.customerName) {
    const resolved = await resolveCustomer(session, slots.customerName, meta.toolCalls);
    if (resolved.kind === 'none') {
      return finish('failed', `没有找到客户「${slots.customerName}」。请先确认客户名称。`, {}, meta);
    }
    if (resolved.kind === 'many') {
      return askClarification(resolved.questions, meta.taskState, meta.intentSource, meta.traceId, meta.toolCalls, slots);
    }
    customerId = resolved.customerId;
  }
  if (!customerId) {
    return askClarification(
      [{ slot: 'customerId', reason: 'missing' }],
      meta.taskState,
      meta.intentSource,
      meta.traceId,
      meta.toolCalls,
      slots,
    );
  }

  // 3. 商品消歧 + 取档案报价
  if (!sku && slots.productTerm) {
    const inventory = await session.callTool('inventory.check', { sku: slots.productTerm });
    meta.toolCalls.push({ tool: 'inventory.check', status: inventory.status, risk: inventory.risk });
    const items = (envelopeData(inventory).items as Array<{ productId: string; sku: string; name: string; unitPrice: number }>) ?? [];
    if (items.length === 0) {
      return finish('failed', `库存档案里没有「${slots.productTerm}」。`, {}, meta);
    }
    if (items.length > 1) {
      return askClarification(
        [
          {
            slot: 'sku',
            reason: 'ambiguous',
            candidates: items.map((item) => ({ id: item.sku, label: `${item.name}（${item.sku}）`, matchReason: 'sku_or_name_match' })),
          },
        ],
        meta.taskState,
        meta.intentSource,
        meta.traceId,
        meta.toolCalls,
        { ...slots, customerId },
      );
    }
    sku = items[0].sku;
    // 模型没拿到单价时用档案价；拿到了就照抄，让契约去核对——
    // 私自改价会在 price_matches_master 处被拦下，这正是要演示的性质。
    if (slots.unitPrice === undefined) slots = { ...slots, unitPrice: items[0].unitPrice };
  }
  if (!sku || slots.quantity === undefined || slots.unitPrice === undefined) {
    const missing: ClarifyQuestion[] = [];
    if (!sku) missing.push({ slot: 'sku', reason: 'missing' });
    if (slots.quantity === undefined) missing.push({ slot: 'quantity', reason: 'missing' });
    if (slots.unitPrice === undefined) missing.push({ slot: 'unitPrice', reason: 'missing' });
    return askClarification(missing, meta.taskState, meta.intentSource, meta.traceId, meta.toolCalls, {
      ...slots,
      customerId,
      sku,
    });
  }

  // 4. 预览。参数由服务端契约归一化，Runtime 只负责把槽位递过去。
  // 持久化的 intent 必须用「顶层可重放槽位」而不是 previewArgs 的嵌套形状：
  // 未结算执行后的重试会把它直接传回本函数，缺 sku/quantity/unitPrice 会退化成追问。
  const operationSlots: OrderSlots = {
    ...slots,
    customerId,
    sku,
    quantity: slots.quantity,
    unitPrice: slots.unitPrice,
    depositRate: slots.depositRate ?? 0,
    termsDays: slots.termsDays ?? 0,
  };
  const operationIntent: IntentResult = {
    kind: 'operation',
    contract: 'create_order',
    slots: operationSlots,
  };
  const previewArgs = {
    customerId,
    items: [{ sku, quantity: slots.quantity, unitPrice: slots.unitPrice }],
    depositRate: slots.depositRate ?? 0,
    termsDays: slots.termsDays ?? 0,
  };
  const preview = await session.callTool('order.preview_create', previewArgs);
  meta.toolCalls.push({ tool: 'order.preview_create', status: preview.status, risk: preview.risk });

  if (preview.status === 'blocked') {
    // 防御分支：有 marker 时主流程不会进入预览。若未来改动让这里可达，
    // 也绝不能清掉未结算标记，更不能声称"没有产生写入"——原 attempt
    // 仍可能已经提交副作用。
    if (meta.taskState.pendingExecutionAttemptId) {
      return finish(
        'executing',
        '本次预览被阻断，但上一笔执行结果仍未结算，无法断言没有写入；请等待对账并使用同一操作重试。',
        {
          idempotencyKey: meta.taskState.idempotencyKey ?? null,
          pendingExecutionAttemptId: meta.taskState.pendingExecutionAttemptId,
          ...pendingFields(meta.taskState, null),
        },
        { ...meta, envelope: preview },
      );
    }
    const lines = ['本次操作被契约阻断，没有产生任何写入：', ...(preview.reasons ?? [])];
    (preview.error?.checks ?? []).forEach((check) => lines.push(`  · ${check.code} — ${check.message}`));
    return finish('failed', lines.join('\n'), { intent: null }, { ...meta, envelope: preview });
  }

  if (preview.status === 'needs_confirmation') {
    const diffLines = (preview.diff ?? []).map((entry) => `  · ${entry.label ?? `${entry.action} ${entry.entity}`}`);
    const reply = [
      `风险等级 ${preview.risk}，需要人工确认。`,
      '判定依据：',
      ...(preview.reasons ?? []).map((reason) => `  · ${reason}`),
      '服务端计算出的变更（不是模型摘要）：',
      ...diffLines,
      '请在确认区批准或拒绝。批准前不会有任何写入。',
    ].join('\n');

    return finish(
      'awaiting_confirmation',
      reply,
      {
        intent: operationIntent,
        pendingPreviewId: preview.previewId ?? null,
        pendingIntentHash: '',
        pendingContract: 'create_order',
        pendingContractVersion: '1.0',
        pendingExpiresAt: preview.expiresAt ? new Date(preview.expiresAt) : null,
        activeCustomerId: customerId,
        // 重试路径沿用未结算执行的 key；新操作生成新 key。
        idempotencyKey: idempotencyKeyFor(meta.taskState),
        clarificationRounds: 0,
      },
      { ...meta, envelope: preview },
    );
  }

  // 5. L1：令牌签发即生效，Runtime 可以直接执行（仍然幂等 + 留审计）。
  // 结果未知后的重试必须复用 TaskState 中的 key，否则会创建第二次副作用。
  if (preview.status === 'ok' && preview.confirmationToken) {
    const idempotencyKey = idempotencyKeyFor(meta.taskState);
    const executed = await session.callTool('order.execute_create', {
      confirmation_token: preview.confirmationToken,
      idempotency_key: idempotencyKey,
    });
    meta.toolCalls.push({ tool: 'order.execute_create', status: executed.status, risk: executed.risk });
    return reportExecution(executed, idempotencyKey, { ...meta, operationIntent, preview });
  }

  return finish('failed', preview.error?.message ?? '预览未成功。', {}, { ...meta, envelope: preview });
}

export function reportExecution(
  executed: Envelope,
  idempotencyKey: string,
  meta: ExecutionReportMeta,
): AgentTurnResult {
  // 机器可识别的执行状态优先于通用 status 分支：这两个错误码表示副作用可能
  // 已经发生，必须在清空 pending 之前截获。
  const pending = executionPendingResult(executed, idempotencyKey, meta);
  if (pending) return pending;

  if (executed.status === 'ok') {
    const data = envelopeData(executed);
    const reply = [
      `订单已创建：${String(data.orderNo ?? '')}`,
      `总额 ¥${Number(data.totalAmount ?? 0).toFixed(2)}，定金 ¥${Number(data.deposit ?? 0).toFixed(2)}，余款 ¥${Number(data.balance ?? 0).toFixed(2)}（${String(data.termsDays ?? 0)} 天账期）`,
      `审计事件：${String(executed.auditId ?? '')}`,
    ].join('\n');
    return finish(
      'completed',
      reply,
      {
        ...clearedExecutionFields(),
        activeOrderId: (data.orderId as string) ?? null,
      },
      { ...meta, envelope: executed },
    );
  }

  if (executed.status === 'conflict') {
    return finish(
      'conflict',
      `执行冲突，未产生写入：${executed.error?.message ?? ''}\n需要重新预览；旧令牌已作废。`,
      clearedExecutionFields(),
      { ...meta, envelope: executed },
    );
  }

  return finish(
    'failed',
    executed.error?.message ?? '执行失败。',
    clearedExecutionFields(),
    { ...meta, envelope: executed },
  );
}

import { randomUUID } from 'node:crypto';
import { connectTefClient, type TefClientSession } from '@/mcp-server';
import type { TaskStatePatch } from '@/tef/task-state';
import type { ClarifyQuestion, Envelope, IntentResult, TaskState, TaskStatus, TenantRole } from '@/tef/types';
import { parseIntent } from './intent';

/**
 * 最小 Agent Runtime（L2/L3）。
 *
 * 公理 I2：这个模块不 import Prisma、不 import BusinessEngine、也不碰令牌与快照存储。
 * 它唯一的对外能力是一个 MCP client——业务数据只能通过注册过的工具拿到。
 * eslint.config.mjs 里有一条 no-restricted-imports 规则把这条约束变成可执行检查。
 *
 * TaskState 的持久化在调用方（API 路由，属 L2 会话层）完成：
 * 本模块只接收序列化后的 TaskState、返回一个 patch。
 */

export interface RuntimePrincipal {
  tenantId: string;
  userId: string;
  sessionId: string;
  role: TenantRole;
}

export interface AgentTurnInput {
  message: string;
  conversationId: string;
  principal: RuntimePrincipal;
  taskState: TaskState;
  traceId: string;
  secret: string;
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

  return { intent: { kind: 'operation', contract: 'create_order', slots: base as Record<string, unknown> }, slots: base };
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const { principal, traceId, secret, taskState } = input;
  const toolCalls: ToolCallRecord[] = [];

  const session = await connectTefClient({
    principal: { ...principal, clientKind: 'agent' },
    traceId,
    secret,
  });

  try {
    // 1. 澄清回填优先：上一轮问了什么，这一轮就在回答什么
    const resumed = taskState.status === 'awaiting_clarification' ? resolveClarification(taskState, input.message) : null;

    let intent: IntentResult;
    let intentSource: 'model' | 'deterministic';
    if (resumed) {
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
    { clarificationRounds: rounds, intent: { kind: 'clarify', questions, slots: { ...previousSlots, ...partialSlots } } },
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

async function handleCreateOrder(
  session: TefClientSession,
  slots: OrderSlots,
  meta: { taskState: TaskState; traceId: string; toolCalls: ToolCallRecord[]; intentSource: 'model' | 'deterministic' },
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
  const previewArgs = {
    customerId,
    items: [{ sku, quantity: slots.quantity, unitPrice: slots.unitPrice }],
    depositRate: slots.depositRate ?? 0,
    termsDays: slots.termsDays ?? 0,
  };
  const preview = await session.callTool('order.preview_create', previewArgs);
  meta.toolCalls.push({ tool: 'order.preview_create', status: preview.status, risk: preview.risk });

  if (preview.status === 'blocked') {
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
        intent: { kind: 'operation', contract: 'create_order', slots: previewArgs as unknown as Record<string, unknown> },
        pendingPreviewId: preview.previewId ?? null,
        pendingIntentHash: '',
        pendingContract: 'create_order',
        pendingContractVersion: '1.0',
        pendingExpiresAt: preview.expiresAt ? new Date(preview.expiresAt) : null,
        activeCustomerId: customerId,
        idempotencyKey: randomUUID(),
        clarificationRounds: 0,
      },
      { ...meta, envelope: preview },
    );
  }

  // 5. L1：令牌签发即生效，Runtime 可以直接执行（仍然幂等 + 留审计）
  if (preview.status === 'ok' && preview.confirmationToken) {
    const idempotencyKey = randomUUID();
    const executed = await session.callTool('order.execute_create', {
      confirmation_token: preview.confirmationToken,
      idempotency_key: idempotencyKey,
    });
    meta.toolCalls.push({ tool: 'order.execute_create', status: executed.status, risk: executed.risk });
    return reportExecution(executed, idempotencyKey, meta);
  }

  return finish('failed', preview.error?.message ?? '预览未成功。', {}, { ...meta, envelope: preview });
}

function reportExecution(
  executed: Envelope,
  idempotencyKey: string,
  meta: { traceId: string; toolCalls: ToolCallRecord[]; intentSource: 'model' | 'deterministic' },
): AgentTurnResult {
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
      { activeOrderId: (data.orderId as string) ?? null, idempotencyKey, intent: null, pendingPreviewId: null },
      { ...meta, envelope: executed },
    );
  }

  if (executed.status === 'conflict') {
    return finish(
      'conflict',
      `执行冲突，未产生写入：${executed.error?.message ?? ''}\n需要重新预览；旧令牌已作废。`,
      { pendingPreviewId: null, intent: null },
      { ...meta, envelope: executed },
    );
  }

  return finish('failed', executed.error?.message ?? '执行失败。', { pendingPreviewId: null }, { ...meta, envelope: executed });
}

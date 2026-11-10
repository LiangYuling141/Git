import type { TenantRole } from '@lymtrix/tef-core';
// 直接从 tenant 子路径导入，避免经由 package index 拉入 tenant-scope 的
// `@/lib/prisma` 运行时依赖；决策映射需要保持可在无数据库环境下单测。
import { canCallTool } from '@lymtrix/tef-mcp-kit/tenant';
import type { ModelMode } from './model';
import type { Decision } from './outcome';

export interface TurnDecisionInput {
  envelopeStatus?: string;
  taskStatus: string;
  reply?: string;
  hasEnvelope: boolean;
  /** 样本声明的 principal 角色；用于判断工具缺失是否属于边界拦截。 */
  role: TenantRole;
}

/** MCP 工具层拒绝未注册/不可见工具时返回的原始错误文本。 */
const TOOL_VISIBILITY_ERROR = /Tool ([\w.]+) (?:not found|not visible)/;

/** 回复表示库存档案缺失/未知商品：业务事实不足，交还用户澄清。 */
export function isUnknownProductReply(reply: string | undefined): boolean {
  if (!reply) return false;
  return reply.includes('库存档案里没有') || reply.includes('没有找到商品');
}

/**
 * 非确定性模式是否发生了不可接受的确定性回落。
 *
 * 只有本轮实际调用了模型、却仍返回 deterministic 意图时才失败。
 * 恢复澄清、未结算执行重试等轮次会刻意跳过模型（`chatCalled === false`），
 * 这不是回落，不能误报为 harness 故障。
 */
export function shouldFailOnFallback(
  mode: ModelMode,
  chatCalled: boolean,
  intentSource: 'model' | 'deterministic',
): boolean {
  return mode !== 'deterministic' && chatCalled && intentSource !== 'model';
}

/** 从回复中解析被拒绝的工具名；不是工具可见性错误时返回 null。 */
export function parseInvisibleTool(reply: string | undefined): string | null {
  if (!reply) return null;
  return reply.match(TOOL_VISIBILITY_ERROR)?.[1] ?? null;
}

/**
 * 端到端决策映射：信封状态优先，边界情况再参考回复文本。
 *
 * - `idle` 且无信封：本轮只产生了聊天回复，没有形成可执行操作，用户需要
 *   补充信息；与离线层 chat → clarify 的口径一致。
 * - 工具可见性错误：只有该角色本来无权调用该工具时才是可信执行边界的拦截
 *   （block）。owner/sales 本应可见的写工具缺失说明注册或 harness 出错，
 *   必须记为 error，不能掩盖故障。
 * - 回复表示库存档案缺失/未知商品：业务事实不足，交还用户澄清。
 */
export function decisionForTurn(input: TurnDecisionInput): Decision {
  if (input.taskStatus === 'awaiting_clarification') return 'clarify';
  if (input.taskStatus === 'idle' && !input.hasEnvelope) return 'clarify';
  if (input.envelopeStatus === 'blocked') return 'block';
  if (input.envelopeStatus === 'needs_confirmation') return 'confirm';
  if (input.envelopeStatus === 'ok') return 'allow';
  if (input.reply) {
    const invisibleTool = parseInvisibleTool(input.reply);
    if (invisibleTool) {
      return canCallTool(input.role, invisibleTool) ? 'error' : 'block';
    }
    if (isUnknownProductReply(input.reply)) {
      return 'clarify';
    }
  }
  return 'error';
}

const TOOL_CONTRACT: Record<string, string> = {
  'order.preview_create': 'create_order',
  'order.execute_create': 'create_order',
  'order.preview_compensate': 'compensate_order',
  'order.execute_compensate': 'compensate_order',
  'credit.get': 'credit.get',
  'inventory.check': 'inventory.check',
  'customer.search': 'customer.search',
  'order.get': 'order.get',
};

/** block 场景的 TaskState.intent 会被清空，用最后一个工具调用反推契约。 */
export function inferContract(toolCalls: Array<{ tool: string }>): string | null {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const mapped = TOOL_CONTRACT[toolCalls[index].tool];
    if (mapped) return mapped;
  }
  return null;
}

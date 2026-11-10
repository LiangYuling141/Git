import {
  AMOUNT_THRESHOLD_KEY,
  SENSITIVE_FIELDS,
  type RiskInput,
  type RiskResult,
  type WhitelistLevel,
} from './types';

/**
 * 唯一风险定级器（docs/technical/14-unified-architecture.md §3）。
 *
 * 这是纯函数：不读墙上时钟、不访问数据库、不依赖全局状态。所有外部输入都经
 * RiskInput 传入——这是评测可复现的前提（§3.1）。系统中不存在第二个定级器；
 * 契约的 riskRules 负责把垂直证据装配成 RiskInput 再委托到这里。
 */

/** 租户未配置金额阈值时的框架默认值。 */
export const DEFAULT_AMOUNT_L2_THRESHOLD = 10000;

/**
 * 白名单只能提高第 3 步的比较基准（§3.3），数值属于 Phase 0 默认值，
 * 待 Phase 2 评测后再校准。它永远不能跳过 preview、人工确认、幂等或审计。
 */
export const WHITELIST_THRESHOLD_MULTIPLIER: Record<WhitelistLevel, number> = {
  none: 1,
  WL1: 1,
  WL2: 1.5,
  WL3: 2,
};

const VALID_OP_TYPES = new Set(['query', 'create', 'update', 'delete']);

export function resolveAmountThreshold(input: RiskInput): number {
  const configured = input.context.tenantThresholds[AMOUNT_THRESHOLD_KEY];
  const base = Number.isFinite(configured) ? (configured as number) : DEFAULT_AMOUNT_L2_THRESHOLD;
  const multiplier = WHITELIST_THRESHOLD_MULTIPLIER[input.context.whitelistLevel] ?? 1;
  return base * multiplier;
}

/**
 * §3.2 判定顺序。Block 拥有最高优先级且不可被任何因子降级，命中即终止。
 */
export function classifyRisk(input: RiskInput): RiskResult {
  // 1. Block 条件
  const blocks: string[] = [];
  if (!VALID_OP_TYPES.has(input.opType)) {
    blocks.push(`unknown_op_type:${input.opType}`);
  }
  if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount < 0)) {
    blocks.push(`invalid_amount:${String(input.amount)}`);
  }
  if (blocks.length > 0) {
    return { level: 'Block', reasons: blocks };
  }

  // 2. 只读查询恒为 L0。白名单与阈值都不能影响这一步。
  if (input.opType === 'query') {
    return { level: 'L0', reasons: ['read_only_query'] };
  }

  const reasons: string[] = [];

  // 3. 金额 > 租户阈值
  if (input.amount !== undefined) {
    const threshold = resolveAmountThreshold(input);
    if (input.amount > threshold) {
      reasons.push(`amount ${input.amount} > threshold ${threshold}`);
    }
  }

  // 4. 命中敏感字段
  const sensitive = input.fields.filter((field) => SENSITIVE_FIELDS.includes(field));
  if (sensitive.length > 0) {
    reasons.push(`sensitive_fields:${sensitive.join(',')}`);
  }

  // 5. 客户为 high_risk / restricted
  if (input.customer.type === 'high_risk' || input.customer.type === 'restricted') {
    reasons.push(`customer_type:${input.customer.type}`);
  }

  // 6. 其余写入
  if (reasons.length === 0) {
    return { level: 'L1', reasons: ['low_risk_write'] };
  }
  return { level: 'L2', reasons };
}

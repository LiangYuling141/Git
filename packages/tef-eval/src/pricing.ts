import type { TokenUsage } from '@lymtrix/tef-runtime';
import type { ModelMode } from './model';

export interface PricingSnapshot {
  capturedAt: string;
  source: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * 价目快照：实现阶段（任务 9 步骤 1）从官方页面获取后填入完整对象。
 * 若无法获取，保持 null；报告中的成本必须显示 null，不得用猜测值。
 */
export const PRICING_SNAPSHOT: PricingSnapshot | null = null;

export function estimateCost(
  usage: TokenUsage | undefined,
  pricing: PricingSnapshot | null = PRICING_SNAPSHOT,
): number | null {
  if (!usage || !pricing) return null;
  return (
    (usage.promptTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/**
 * 样本级成本：只有 live 模式且存在 usage 时才折算真实计费。
 * 任何一条 usage 无法按价目快照计价时整体返回 null，不得用 0 掩盖未知成本。
 * pricing 参数仅供测试注入，默认始终使用 PRICING_SNAPSHOT。
 */
export function computeSampleCost(
  usages: TokenUsage[],
  modelMode: ModelMode,
  pricing: PricingSnapshot | null = PRICING_SNAPSHOT,
): number | null {
  if (modelMode !== 'live' || usages.length === 0) return null;
  let total = 0;
  for (const usage of usages) {
    const cost = estimateCost(usage, pricing);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

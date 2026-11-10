import type { TokenUsage } from '@lymtrix/tef-runtime';

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

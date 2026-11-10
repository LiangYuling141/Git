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
 * 价目快照：2026-11-10 抓取自官方页面
 * https://api-docs.deepseek.com/quick_start/pricing
 *
 * 实际请求的 `deepseek-chat` 别名由服务端映射为 `deepseek-flash`
 * （录制响应中的 model 字段），因此按 deepseek-flash 计价。
 * 官方同时给出高峰/低谷与缓存命中/未命中价格；TokenUsage 只保留总
 * prompt/completion token，没有缓存命中拆分，所以这里取“高峰 + 缓存
 * 未命中输入价”作为保守上界，报告需注明该口径。
 */
export const PRICING_SNAPSHOT: PricingSnapshot | null = {
  capturedAt: '2026-11-10',
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  model: 'deepseek-flash',
  inputPerMillion: 0.3,
  outputPerMillion: 1.2,
};

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

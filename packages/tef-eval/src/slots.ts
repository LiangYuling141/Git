/**
 * 澄清槽位的规范化与槽位值比较。
 *
 * 模型、确定性解析器与契约引擎对同一业务字段使用不同命名
 * （`customerId` / `customerName` / `customer`），指标必须先把它们
 * 归一到同一组 canonical 槽位，否则槽位召回率会被命名差异污染。
 */

export const CANONICAL_CLARIFY_SLOTS = [
  'customer',
  'product',
  'order',
  'quantity',
  'unitPrice',
  'depositRate',
  'termsDays',
] as const;

export type CanonicalClarifySlot = (typeof CANONICAL_CLARIFY_SLOTS)[number];

const SLOT_ALIASES: Record<string, CanonicalClarifySlot> = {
  customerid: 'customer',
  customername: 'customer',
  customer: 'customer',
  orderid: 'order',
  orderno: 'order',
  order: 'order',
  productterm: 'product',
  sku: 'product',
  product: 'product',
};

/**
 * 把任意来源的槽位名转换为 canonical 槽位。
 *
 * 未知槽位保持 trim 后的原名，不静默丢弃：指标会把它当作未匹配项，
 * 从而暴露“模型问了计划外槽位”的事实。
 */
export function normalizeClarifySlot(slot: string): string {
  const trimmed = slot.trim();
  return SLOT_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** 规范化并按出现顺序去重，避免同一业务槽位被多个别名重复计数。 */
export function normalizeClarifySlots(slots: readonly string[]): string[] {
  const normalized = slots.map(normalizeClarifySlot);
  return [...new Set(normalized)];
}

/**
 * 槽位值比较的可归一化表示：字符串 trim，对象按键名排序，数组逐项处理。
 * 只用于比较，不改变持久化的原始槽位。
 */
function comparableValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(comparableValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, comparableValue(item)]));
  }
  return value;
}

/** 数字按数值、字符串 trim、对象忽略键顺序的严格相等。 */
export function slotValuesEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(comparableValue(actual)) === JSON.stringify(comparableValue(expected));
}

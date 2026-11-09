/**
 * 金额运算：一律在整数分上进行。
 *
 * 契约的 invariants 要校验 `total == Σ(qty × price) − discount`。用浮点直接算，
 * 0.1 + 0.2 这类误差会让校验随机失败，而"可信执行框架"最不能接受的就是
 * 无法解释的判定结果。所以入口把元转成分（整数），出口再转回元。
 */

const CENTS_SCALE = 100;
/** 先定点截断再四舍五入，消掉 n * 100 的二进制表示噪声。 */
const NOISE_DIGITS = 6;

export function toCents(yuan: number): number {
  if (!Number.isFinite(yuan)) {
    throw new TypeError(`cannot convert non-finite amount to cents: ${String(yuan)}`);
  }
  return Math.round(Number((yuan * CENTS_SCALE).toFixed(NOISE_DIGITS)));
}

export function fromCents(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`cents must be an integer, got ${cents}`);
  }
  return cents / CENTS_SCALE;
}

/** 按比例分摊金额（定金、折扣），结果仍是整数分。 */
export function prorateCents(totalCents: number, rate: number): number {
  if (!Number.isFinite(rate)) {
    throw new TypeError(`rate must be finite, got ${String(rate)}`);
  }
  return Math.round(Number((totalCents * rate).toFixed(NOISE_DIGITS)));
}

export function formatCNY(cents: number): string {
  return `¥${fromCents(cents).toFixed(2)}`;
}

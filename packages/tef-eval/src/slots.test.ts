import { describe, expect, it } from 'vitest';
import {
  normalizeClarifySlot,
  normalizeClarifySlots,
  slotValuesEqual,
} from './slots';

describe('clarify slot normalization', () => {
  it('maps aliases to canonical business slots', () => {
    expect(normalizeClarifySlot('customerId')).toBe('customer');
    expect(normalizeClarifySlot(' customerName ')).toBe('customer');
    expect(normalizeClarifySlot('customer')).toBe('customer');
    expect(normalizeClarifySlot('orderId')).toBe('order');
    expect(normalizeClarifySlot('orderNo')).toBe('order');
    expect(normalizeClarifySlot('order')).toBe('order');
    expect(normalizeClarifySlot('productTerm')).toBe('product');
    expect(normalizeClarifySlot('sku')).toBe('product');
    expect(normalizeClarifySlot('product')).toBe('product');
    expect(normalizeClarifySlot('quantity')).toBe('quantity');
    expect(normalizeClarifySlot('unitPrice')).toBe('unitPrice');
  });

  it('keeps unknown slots visible and deduplicates after normalization', () => {
    expect(normalizeClarifySlot('warehouse')).toBe('warehouse');
    expect(normalizeClarifySlots(['customerId', 'customerName', 'sku', 'warehouse'])).toEqual([
      'customer',
      'product',
      'warehouse',
    ]);
  });
});

describe('slotValuesEqual', () => {
  it('trims strings and ignores object key order', () => {
    expect(slotValuesEqual(' 伟业公司 ', '伟业公司')).toBe(true);
    expect(
      slotValuesEqual({ name: '伟业', tags: ['a'] }, { tags: ['a'], name: '伟业' }),
    ).toBe(true);
  });

  it('keeps numeric and string values distinct', () => {
    expect(slotValuesEqual('100', 100)).toBe(false);
    expect(slotValuesEqual(100, 100)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalize } from './canonical';

describe('canonicalize', () => {
  it('与对象键的插入顺序无关', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('递归排序嵌套对象的键', () => {
    const left = { outer: { z: 1, a: { d: 4, c: 3 } }, b: 2 };
    const right = { b: 2, outer: { a: { c: 3, d: 4 }, z: 1 } };
    expect(canonicalize(left)).toBe(canonicalize(right));
  });

  it('保留数组顺序', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('数组内对象同样按键序归一', () => {
    expect(canonicalize([{ b: 1, a: 2 }])).toBe(canonicalize([{ a: 2, b: 1 }]));
  });

  it('Date 归一为 UTC ISO 字符串', () => {
    expect(canonicalize(new Date('2026-11-07T08:09:10.123Z'))).toBe('"2026-11-07T08:09:10.123Z"');
    expect(canonicalize({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
  });

  it('省略值为 undefined 的键', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('把 -0 归一为 0', () => {
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it('区分 null 与缺失的键', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  it('拒绝数组里的 undefined，避免与 null 混淆', () => {
    expect(() => canonicalize([1, undefined, 3])).toThrow(CanonicalizationError);
  });

  it('拒绝非有限数值', () => {
    expect(() => canonicalize({ amount: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ amount: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it('拒绝 Invalid Date', () => {
    expect(() => canonicalize(new Date('not-a-date'))).toThrow(/Invalid Date/);
  });

  it('拒绝 bigint / symbol / function', () => {
    expect(() => canonicalize({ n: BigInt(1) })).toThrow(/not hashable/);
    expect(() => canonicalize({ f: () => 1 })).toThrow(/not hashable/);
    expect(() => canonicalize(Symbol('x'))).toThrow(/not hashable/);
  });

  it('拒绝类实例：只接受纯对象，防止隐藏状态被漏掉', () => {
    class Money {
      constructor(readonly cents: number) {}
    }
    expect(() => canonicalize(new Money(100))).toThrow(/only plain objects/);
    expect(() => canonicalize(new Map())).toThrow(/only plain objects/);
    expect(() => canonicalize(new Set())).toThrow(/only plain objects/);
  });

  it('拒绝循环引用而不是栈溢出', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(CanonicalizationError);
  });

  it('错误信息带上出问题的路径', () => {
    try {
      canonicalize({ order: { items: [{ qty: Number.NaN }] } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalizationError);
      expect((err as CanonicalizationError).path).toBe('order.items[0].qty');
    }
  });
});

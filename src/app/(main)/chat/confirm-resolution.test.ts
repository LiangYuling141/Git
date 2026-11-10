import { describe, expect, it } from 'vitest';
import { resolveCardResolution } from './confirm-resolution';

describe('确认卡片的结算映射', () => {
  it('executing 不是确定结果：批准与拒绝都保持卡片未决', () => {
    expect(resolveCardResolution({ ok: true, action: 'approve', status: 'executing' })).toBeUndefined();
    // 未结算期间拒绝不会撤销可能的副作用，不能显示"已拒绝"。
    expect(resolveCardResolution({ ok: true, action: 'reject', status: 'executing' })).toBeUndefined();
  });

  it('HTTP 失败保持未决，避免把网络错误当成用户拒绝', () => {
    expect(resolveCardResolution({ ok: false, action: 'reject', status: 'failed' })).toBeUndefined();
    expect(resolveCardResolution({ ok: false, action: 'approve', status: 'completed' })).toBeUndefined();
  });

  it('确定结果按动作与状态映射', () => {
    expect(resolveCardResolution({ ok: true, action: 'reject', status: 'failed' })).toBe('rejected');
    expect(resolveCardResolution({ ok: true, action: 'approve', status: 'completed' })).toBe('executed');
    expect(resolveCardResolution({ ok: true, action: 'approve', status: 'compensated' })).toBe('executed');
    expect(resolveCardResolution({ ok: true, action: 'approve', status: 'conflict' })).toBe('conflict');
    expect(resolveCardResolution({ ok: true, action: 'approve', status: 'failed' })).toBe('failed');
    expect(resolveCardResolution({ ok: true, action: 'approve', status: 'compensation_failed' })).toBe('failed');
    expect(resolveCardResolution({ ok: true, action: 'approve', status: 'awaiting_confirmation' })).toBeUndefined();
  });
});

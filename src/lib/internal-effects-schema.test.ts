import { describe, expect, it } from 'vitest';
import { effectsRequestSchema } from './internal-effects-schema';

/**
 * bind 的语义是 payload[bindKey] = refs[fromRef][field]，越权守卫必须检查
 * bind 的 KEY（目标 payload 字段），而不是来源 ref 的 field。
 */

function requestWith(effect: Record<string, unknown>) {
  return {
    tenantId: 't_yiwu_demo',
    idempotencyKey: 'idem_effects_schema',
    effects: [effect],
  };
}

describe('effectsRequestSchema bind 越权守卫', () => {
  it('bind 目标为 tenantId 时拒绝', () => {
    const result = effectsRequestSchema.safeParse(
      requestWith({
        type: 'update',
        entity: 'order',
        target: 'so_1',
        payload: {},
        bind: { tenantId: { fromRef: 'order', field: 'orderNo' } },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('bind 目标为 id 时拒绝', () => {
    const result = effectsRequestSchema.safeParse(
      requestWith({
        type: 'update',
        entity: 'product',
        target: 'p_1',
        payload: {},
        bind: { id: { fromRef: 'product', field: 'sku' } },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('bind 目标为 orderId、来源字段为 id 时允许', () => {
    const result = effectsRequestSchema.safeParse(
      requestWith({
        type: 'update',
        entity: 'order',
        target: 'so_1',
        payload: {},
        bind: { orderId: { fromRef: 'order', field: 'id' } },
      }),
    );

    expect(result.success).toBe(true);
  });
});

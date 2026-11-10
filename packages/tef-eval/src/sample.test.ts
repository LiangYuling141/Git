import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evalSampleSchema, loadSamples } from './sample';

const CUSTOMER = {
  id: 'c_weiye',
  name: '义乌市伟业进出口有限公司',
  phone: '13800000001',
  status: 'active',
  customerType: 'normal',
  creditLimit: 50000,
  creditUsed: 0,
  overdueDays: 0,
  isHighRisk: false,
  monthlyTransaction: 0,
  onboardingStatus: 'completed',
};

const PRODUCT = {
  id: 'p_ball',
  sku: 'XMAS-BALL-01',
  name: '圣诞球',
  unitPrice: 2,
  availableQty: 20000,
  reservedQty: 0,
  unit: '个',
};

function sample(overrides: Record<string, unknown> = {}) {
  return {
    id: 'normal_l1_order',
    category: 'normal',
    tenant: { thresholds: { amountL2Threshold: 5000 } },
    principal: { userId: 'u_eval', role: 'owner' },
    input: { messages: ['给伟业公司下 100 个圣诞球，单价 2 块'] },
    intent: { contract: 'create_order', slots: { customerName: '伟业公司' } },
    fixtures: { customers: [CUSTOMER], products: [PRODUCT], orders: [] },
    expect: { decision: 'allow', risk: 'L1', contract: 'create_order' },
    tags: ['normal'],
    ...overrides,
  };
}

describe('eval sample schema', () => {
  it('accepts a valid sample', () => {
    expect(evalSampleSchema.parse(sample()).id).toBe('normal_l1_order');
  });

  it('rejects an unknown category', () => {
    expect(() => evalSampleSchema.parse(sample({ category: 'unknown' }))).toThrow();
  });

  it('rejects an unknown decision', () => {
    expect(() =>
      evalSampleSchema.parse(sample({ expect: { decision: 'maybe' } })),
    ).toThrow();
  });

  it('rejects ids that could escape recording paths or inject reports', () => {
    for (const id of ['../outside', 'a/b', 'evil|id', 'with space', 'x'.repeat(65)]) {
      expect(() => evalSampleSchema.parse(sample({ id }))).toThrow();
    }
    expect(evalSampleSchema.parse(sample({ id: 'normal_l1_order-2' })).id).toBe(
      'normal_l1_order-2',
    );
  });

  it('accepts canonical clarify slots and rejects non-canonical ones', () => {
    expect(
      evalSampleSchema.parse(sample({ expect: { decision: 'clarify', clarifySlots: ['customer'] } }))
        .expect.clarifySlots,
    ).toEqual(['customer']);
    expect(() =>
      evalSampleSchema.parse(
        sample({ expect: { decision: 'clarify', clarifySlots: ['customerId'] } }),
      ),
    ).toThrow();
  });

  it('loads samples sorted by id and rejects duplicate ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tef-eval-'));
    writeFileSync(join(dir, 'b.json'), JSON.stringify([sample({ id: 'b' })]));
    writeFileSync(join(dir, 'a.json'), JSON.stringify(sample({ id: 'a' })));

    expect(loadSamples(dir).map((item) => item.id)).toEqual(['a', 'b']);

    writeFileSync(join(dir, 'c.json'), JSON.stringify(sample({ id: 'a' })));
    expect(() => loadSamples(dir)).toThrow(/duplicate/i);
  });
});

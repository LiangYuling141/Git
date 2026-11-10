import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import type { EvalSample } from '../../packages/tef-eval/src/sample';
import { runE2eSample } from '../../packages/tef-eval/src/e2e';

const RUN_DB = process.env.TEF_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDb = RUN_DB ? describe : describe.skip;

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

const BASE = {
  tenant: { thresholds: { amountL2Threshold: 5000 } },
  principal: { userId: 'u_eval', role: 'owner' as const },
  fixtures: { customers: [CUSTOMER], products: [PRODUCT], orders: [] },
  tags: [],
};

const SAMPLES: EvalSample[] = [
  {
    ...BASE,
    id: 'normal_l1_order',
    category: 'normal',
    input: { messages: ['给伟业公司下一单 100 个圣诞球，单价 2 块，30 天账期'] },
    expect: { decision: 'allow', risk: 'L1', contract: 'create_order' },
  },
  {
    ...BASE,
    id: 'normal_l2_order',
    category: 'normal',
    input: { messages: ['给伟业公司下一单 5000 个圣诞球，单价 2 块，30% 定金，30 天账期'] },
    expect: { decision: 'confirm', risk: 'L2', contract: 'create_order' },
  },
  {
    ...BASE,
    id: 'conflict_credit_insufficient',
    category: 'conflict',
    fixtures: {
      customers: [
        CUSTOMER,
        {
          ...CUSTOMER,
          id: 'c_xiaoyu',
          name: '义乌市小雨贸易有限公司',
          phone: '13800000003',
          creditLimit: 5000,
          creditUsed: 4800,
        },
      ],
      products: [PRODUCT],
      orders: [],
    },
    input: { messages: ['给小雨贸易下一单 1000 个圣诞球，单价 2 块'] },
    expect: { decision: 'block', contract: 'create_order' },
  },
];

describeDb('Phase D 端到端评测（真实数据库）', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('runs representative samples through the MCP tool chain with fixture evidence', async () => {
    const outcomes = [];
    for (const sample of SAMPLES) {
      outcomes.push(await runE2eSample(sample, 'deterministic'));
    }

    expect(outcomes.map((item) => item.actual.decision)).toEqual(['allow', 'confirm', 'block']);
    expect(outcomes.map((item) => item.actual.risk)).toEqual(['L1', 'L2', 'Block']);
    expect(outcomes.map((item) => item.actual.contract)).toEqual([
      'create_order',
      'create_order',
      'create_order',
    ]);
    expect(outcomes.every((item) => Array.isArray(item.actual.reasons))).toBe(true);
    expect(outcomes.every((item) => Array.isArray(item.actual.clarifySlots))).toBe(true);
    // 每条样本都必须把决策链 traceId 持久化到 outcome，避免证据只留在治理表。
    expect(
      outcomes.every(
        (item) =>
          typeof item.traceId === 'string' &&
          item.traceId.startsWith(`tr_eval_${item.sampleId}_`),
      ),
    ).toBe(true);
    expect(outcomes.every((item) => item.traceIds === undefined)).toBe(true);
  }, 60000);
});

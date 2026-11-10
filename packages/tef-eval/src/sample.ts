import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CANONICAL_CLARIFY_SLOTS } from './slots';

export const EVAL_CATEGORIES = [
  'normal',
  'ambiguous',
  'adversarial',
  'boundary',
  'conflict',
  'clarify',
] as const;

const customerRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  phone: z.string(),
  status: z.string().min(1),
  customerType: z.string().min(1),
  creditLimit: z.number(),
  creditUsed: z.number(),
  overdueDays: z.number().int(),
  isHighRisk: z.boolean(),
  monthlyTransaction: z.number(),
  onboardingStatus: z.string(),
});

const productRecordSchema = z.object({
  id: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  unitPrice: z.number(),
  availableQty: z.number().int(),
  reservedQty: z.number().int(),
  unit: z.string(),
});

const paymentRecordSchema = z.object({
  id: z.string().min(1),
  amount: z.number(),
  method: z.string(),
  status: z.string(),
  remark: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
});

const orderRecordSchema = z.object({
  id: z.string().min(1),
  orderNo: z.string().min(1),
  customerId: z.string().min(1),
  customerName: z.string().nullable().optional(),
  items: z.unknown(),
  totalAmount: z.number(),
  discount: z.number().nullable().optional(),
  depositRate: z.number().nullable().optional(),
  deposit: z.number().nullable().optional(),
  balance: z.number(),
  termsDays: z.number().int(),
  status: z.string(),
  traceId: z.string().nullable().optional(),
  previewId: z.string().nullable().optional(),
  payments: z.array(paymentRecordSchema),
  createdAt: z.string(),
});

export const evalSampleSchema = z.object({
  // 样本 id 会用于租户名、traceId 与录制文件名；限制字符集与长度，
  // 防止路径穿越与报告/文件名注入。
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'sample id must match ^[A-Za-z0-9_-]{1,64}$'),
  category: z.enum(EVAL_CATEGORIES),
  tenant: z.object({ thresholds: z.record(z.string(), z.number()) }),
  // 离线层把 userId 用作 ExecContext.userId；端到端层改用派生的
  // `u_eval_<sampleId>` 作为登录用户，不使用该字段作为登录身份。
  // 样本作者不应依赖 principal.userId 在端到端层做身份断言。
  principal: z.object({
    userId: z.string().min(1),
    role: z.enum(['owner', 'sales', 'finance', 'viewer']),
  }),
  now: z.string().datetime().optional(),
  input: z.object({ messages: z.array(z.string().min(1)).min(1) }),
  intent: z
    .object({
      contract: z.string().min(1),
      slots: z.record(z.string(), z.unknown()),
    })
    .optional(),
  fixtures: z.object({
    customers: z.array(customerRecordSchema),
    products: z.array(productRecordSchema),
    orders: z.array(orderRecordSchema),
  }),
  expect: z.object({
    decision: z.enum(['allow', 'confirm', 'block', 'clarify']),
    risk: z.enum(['L0', 'L1', 'L2', 'Block']).optional(),
    contract: z.string().optional(),
    slots: z.record(z.string(), z.unknown()).optional(),
    code: z.string().optional(),
    /** 期望澄清的 canonical 槽位；用于槽位召回率，不要求与决策一一对应。 */
    clarifySlots: z.array(z.enum(CANONICAL_CLARIFY_SLOTS)).optional(),
  }),
  modelResponses: z.array(z.string()).optional(),
  tags: z.array(z.string()),
});

export type EvalSample = z.infer<typeof evalSampleSchema>;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];
export type EvalExpectation = EvalSample['expect'];

export function loadSamples(dir: string): EvalSample[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const samples = files.flatMap((file) => {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    // 一个文件可以是单个样本对象，也可以是样本数组；两种形式都校验。
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => evalSampleSchema.parse(item));
  });

  const seen = new Set<string>();
  for (const item of samples) {
    if (seen.has(item.id)) throw new Error(`duplicate sample id: ${item.id}`);
    seen.add(item.id);
  }
  return samples.sort((a, b) => a.id.localeCompare(b.id));
}

import { z } from 'zod';

/**
 * 内部 effects 网关的请求 schema 与越权字段守卫。
 *
 * entity / type 是垂直白名单：未知组合在触库前被 zod 拒绝，避免通过
 * 任意实体名调用到未授权的适配器。
 *
 * payload 里的 tenantId / id 是越权字段：update 适配器会把 payload 直接展开进
 * Prisma data，若不在这里拒绝，调用方就能改写租户归属或主键。create 同样拒绝，
 * 主键与租户只能由服务端事务上下文决定。
 *
 * bind 的语义是 `payload[bindKey] = refs[fromRef][field]`（见
 * packages/tef-core/src/effect-executor.ts）：bind 的 KEY 才是写入 payload 的目标
 * 字段，`field` 只是来源 ref 上的字段。因此必须拒绝 bind KEY 为 tenantId / id，
 * 而不是拒绝来源字段——后者会误伤合法的
 * `bind: { orderId: { fromRef: 'order', field: 'id' } }`。
 */

const SERVER_CONTROLLED_FIELDS = ['tenantId', 'id'] as const;

const effectSchema = z
  .object({
    type: z.enum(['create', 'update', 'reserve', 'release']),
    entity: z.enum(['order', 'payment', 'product', 'customer']),
    as: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
    target: z.string().optional(),
    increment: z.record(z.string(), z.number()).optional(),
    bind: z.record(z.string(), z.object({ fromRef: z.string(), field: z.string() })).optional(),
  })
  .superRefine((effect, ctx) => {
    for (const key of SERVER_CONTROLLED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(effect.payload, key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', key],
          message: `payload.${key} is not allowed; tenant and primary key are server-controlled`,
        });
      }
    }
    for (const bindKey of findForbiddenBindTargets([effect])) {
      ctx.addIssue({
        code: 'custom',
        path: ['bind', bindKey],
        message: `bind.${bindKey} cannot target ${bindKey}; tenant and primary key are server-controlled`,
      });
    }
  });

/** 返回 bind 目标字段中命中服务端控制字段（tenantId / id）的键。 */
export function findForbiddenBindTargets(
  effects: ReadonlyArray<{ bind?: Record<string, unknown> }>,
): string[] {
  const forbidden = new Set<string>();
  for (const effect of effects) {
    for (const bindKey of Object.keys(effect.bind ?? {})) {
      if ((SERVER_CONTROLLED_FIELDS as readonly string[]).includes(bindKey)) {
        forbidden.add(bindKey);
      }
    }
  }
  return [...forbidden];
}

export const effectsRequestSchema = z.object({
  tenantId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  previewId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  // B2 只接受该字段；证据版本比较与 CONFLICT 语义在 Phase C 落地。
  expectedEvidenceVersion: z.string().min(1).optional(),
  // 空 effects 批次没有业务意义，只会生成无用的幂等记录；直接判为非法请求。
  effects: z.array(effectSchema).min(1),
});

export type EffectsRequestBody = z.infer<typeof effectsRequestSchema>;

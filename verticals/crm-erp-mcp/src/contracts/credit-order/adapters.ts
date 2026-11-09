import { EffectExecutionError, type EntityAdapters } from '@lymatrix/tef-core';
import type { PrismaTx } from '@lymatrix/tef-mcp-kit';

/**
 * 赊账订单契约的实体适配器。
 *
 * 框架核心不认识 order / product（§7.1 注），垂直通过这里把声明式 effect
 * 翻译成 Prisma 写入。所有写入都强制带 tenantId：
 * - create 显式写入 tenantId；
 * - update 走 updateMany + { id, tenantId } 并检查影响行数，
 *   这样即使拿到了别租户的主键也改不动（应用层第二道防线，RLS 是第一道）。
 */

export interface CreditOrderMeta {
  previewId?: string | null;
  traceId?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_NO_RETRIES = 4;

function generateOrderNo(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SO-${stamp}-${rand}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'P2002';
}

/** 把 increment 里"减少"的字段翻译成非负守卫，让预占在并发下不可能超卖。 */
function nonNegativeGuards(increment: Record<string, number> | undefined): Record<string, { gte: number }> {
  const guards: Record<string, { gte: number }> = {};
  for (const [field, delta] of Object.entries(increment ?? {})) {
    if (delta < 0) guards[field] = { gte: -delta };
  }
  return guards;
}

export function createCreditOrderAdapters(
  tx: PrismaTx,
  tenantId: string,
  meta: CreditOrderMeta = {},
): EntityAdapters {
  return {
    order: {
      async create(payload) {
        const { status, ...rest } = payload as Record<string, unknown>;
        for (let attempt = 0; attempt < ORDER_NO_RETRIES; attempt += 1) {
          try {
            const row = await tx.order.create({
              data: {
                ...rest,
                tenantId,
                status: (status as never) ?? 'confirmed',
                orderNo: generateOrderNo(),
                previewId: meta.previewId ?? null,
                traceId: meta.traceId ?? null,
              } as never,
            });
            return row as unknown as Record<string, unknown>;
          } catch (error) {
            if (!isUniqueViolation(error) || attempt === ORDER_NO_RETRIES - 1) throw error;
          }
        }
        throw new EffectExecutionError('INTERNAL', 'failed to generate a unique orderNo');
      },
      async update(target, payload, increment) {
        const result = await tx.order.updateMany({
          where: { id: target, tenantId },
          data: { ...payload, ...incrementData(increment) } as never,
        });
        assertUpdated(result.count, 'order', target);
        return { id: target, tenantId, ...payload };
      },
    },

    payment: {
      async create(payload) {
        // dueInDays 是契约里的声明式表达；落库时翻译成绝对时间，
        // 这样 effects 列表本身仍然是纯数据、可序列化、可审计。
        const { dueInDays, orderId, ...rest } = payload as Record<string, unknown>;
        const dueAt = typeof dueInDays === 'number' ? new Date(Date.now() + dueInDays * DAY_MS) : null;
        const row = await tx.payment.create({
          data: { ...rest, tenantId, orderId: orderId as string, dueAt } as never,
        });
        return row as unknown as Record<string, unknown>;
      },
      async update(target, payload, increment) {
        const result = await tx.payment.updateMany({
          where: { id: target, tenantId },
          data: { ...payload, ...incrementData(increment) } as never,
        });
        assertUpdated(result.count, 'payment', target);
        return { id: target, tenantId, ...payload };
      },
    },

    product: {
      async create(payload) {
        const row = await tx.product.create({ data: { ...payload, tenantId } as never });
        return row as unknown as Record<string, unknown>;
      },
      async update(target, payload, increment) {
        const result = await tx.product.updateMany({
          // 非负守卫让"预占 5000 但只剩 300"在数据库层直接失败，而不是写成负库存
          where: { id: target, tenantId, ...nonNegativeGuards(increment) },
          data: { ...payload, ...incrementData(increment) } as never,
        });
        if (result.count === 0) {
          throw new EffectExecutionError(
            'CONFLICT',
            `inventory for product ${target} changed concurrently; re-preview required`,
          );
        }
        return { id: target, tenantId };
      },
    },

    customer: {
      async create(payload) {
        const row = await tx.customer.create({ data: { ...payload, tenantId } as never });
        return row as unknown as Record<string, unknown>;
      },
      async update(target, payload, increment) {
        // touchLastTransactionDate 是契约里的声明式表达，落库时翻译成绝对时间，
        // 与 payment 的 dueInDays 同理：effects 列表本身保持纯数据、可序列化。
        const { touchLastTransactionDate, ...rest } = payload as Record<string, unknown>;
        const data = touchLastTransactionDate === true ? { ...rest, lastTransactionDate: new Date() } : rest;
        const result = await tx.customer.updateMany({
          where: { id: target, tenantId, ...nonNegativeGuards(increment) },
          data: { ...data, ...incrementData(increment) } as never,
        });
        assertUpdated(result.count, 'customer', target);
        return { id: target, tenantId };
      },
    },
  };
}

function incrementData(increment: Record<string, number> | undefined): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [field, delta] of Object.entries(increment ?? {})) {
    data[field] = { increment: delta };
  }
  return data;
}

function assertUpdated(count: number, entity: string, target: string): void {
  if (count === 0) {
    throw new EffectExecutionError('CONFLICT', `${entity} ${target} is not writable in this tenant`);
  }
}

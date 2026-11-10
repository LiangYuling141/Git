import type { Prisma } from '@/generated/prisma';

/** 过渡期事务类型；Phase B 拆独立存储后由存储适配器提供。 */
export type PrismaTx = Prisma.TransactionClient;

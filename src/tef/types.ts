export * from '@lymatrix/tef-core/types';

import type { Prisma } from '@/generated/prisma';

/**
 * 迁移期兼容：Prisma 事务类型不属于框架核心。
 * Phase A2 会把该类型移到 tef-mcp-kit，并删除此 shim。
 */
export type PrismaTx = Prisma.TransactionClient;

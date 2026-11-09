import type { BusinessGateway } from '@lymtrix/tef-core';
import type { PrismaTx } from '@lymtrix/tef-mcp-kit';
import { createPrismaCrmGateway } from './prisma-gateway';
import { createHttpCrmGateway } from './http-gateway';
import type { CrmBusinessGateway } from './types';

/**
 * 垂直网关工厂：默认保持进程内 Prisma 实现，只有显式
 * `TEF_CRM_GATEWAY=http` 时才跨服务调用 CRM 内部网关。
 *
 * 默认值必须是 Prisma——B2 引入 HTTP 通道但不得改变现有部署行为；
 * HTTP 模式缺少基址或服务令牌时直接失败，不做静默降级。
 */
export function createCrmGateway(tx: PrismaTx, tenantId: string): CrmBusinessGateway {
  const mode = process.env.TEF_CRM_GATEWAY;
  if (mode === 'http') {
    const baseUrl = process.env.TEF_CRM_API_BASE;
    const serviceToken = process.env.TEF_CRM_SERVICE_TOKEN;
    if (!baseUrl) throw new Error('TEF_CRM_API_BASE is not configured');
    if (!serviceToken) throw new Error('TEF_CRM_SERVICE_TOKEN is not configured');
    return createHttpCrmGateway({ baseUrl, serviceToken, tenantId });
  }
  // 拼写错误或未知模式不能静默回落到 Prisma：调用方以为流量走 HTTP
  // 网关，实际仍在进程内直连业务库，是部署期最难发现的配置事故。
  if (mode === undefined || mode === '' || mode === 'prisma') {
    return createPrismaCrmGateway(tx, tenantId);
  }
  throw new Error(`unknown TEF_CRM_GATEWAY: ${mode}`);
}

export type { BusinessGateway };

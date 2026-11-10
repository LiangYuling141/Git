import { TefError, type ExecContext } from '@lymtrix/tef-core';
import type { CrmBusinessGateway } from './types';

/**
 * 契约侧的类型化网关访问。
 *
 * 核心的 `ExecContext.gateway` 是垂直中立的 `BusinessGateway`；CRM 契约需要
 * 带类型的读方法，就在这里收窄。端口缺失时 fail-closed，而不是静默跳过证据加载。
 */
export function requireCrmGateway(ctx: Pick<ExecContext, 'gateway'>): CrmBusinessGateway {
  const gateway = ctx.gateway as CrmBusinessGateway | undefined;
  if (!gateway) throw new TefError('INTERNAL', 'BusinessGateway is not configured');
  // 只实现泛型 query 的网关在类型上满足核心端口，但契约依赖类型化读方法。
  // 这里 fail-closed，避免契约内部因 undefined 方法调用抛出原生 TypeError。
  if (typeof gateway.getCustomer !== 'function') {
    throw new TefError('INTERNAL', 'CRM BusinessGateway implementation is incomplete');
  }
  return gateway;
}

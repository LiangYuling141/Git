import type { Effect } from './types';

export interface BusinessQueryRequest {
  tenantId: string;
  /** 例如 crm.customer.search；由垂直包声明白名单。 */
  operation: string;
  params: Record<string, unknown>;
}

export interface EffectsExecuteRequest {
  tenantId: string;
  idempotencyKey: string;
  previewId: string;
  traceId: string;
  /** 由 B2 定义来源与冲突语义；B1.5 不使用。 */
  expectedEvidenceVersion?: string;
  effects: Effect[];
}

export interface EffectsExecuteResult {
  ok: boolean;
  refs: Record<string, Record<string, unknown>>;
  error?: { code: 'CONFLICT' | 'INTERNAL'; message: string };
}

/**
 * 业务数据访问端口。核心只认识“查询名 + 参数 + 结果”，不认识任何垂直 DTO。
 *
 * 框架核心只依赖这个接口；进程内由 Prisma 实现，跨服务时由 HTTP 实现。
 * 所有查询都必须显式带 tenantId，禁止跨租户读取。
 */
export interface BusinessGateway {
  query<T = unknown>(input: BusinessQueryRequest): Promise<T>;
  executeEffects(input: EffectsExecuteRequest): Promise<EffectsExecuteResult>;
}

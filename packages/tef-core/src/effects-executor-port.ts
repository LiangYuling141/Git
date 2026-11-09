import type { EffectsExecuteRequest, EffectsExecuteResult } from './business-gateway';

/**
 * 副作用执行端口（Phase C）。
 *
 * 执行状态机（contract.ts）只依赖这个端口：Phase 2 通过它执行声明式 effects，
 * Phase 3 结算结果。默认实现是垂直包提供的进程内 CRM 执行器；后续独立存储
 * 或跨服务执行时可以替换实现，而状态机与幂等语义不变。
 *
 * 端口不抛业务错误：CONFLICT 与 INTERNAL 都以结构化结果返回，调用方不需要
 * 用 try/catch 区分“可补偿的业务冲突”和“需要人工介入的内部错误”。
 */
export interface EffectsExecutor {
  execute(input: EffectsExecuteRequest): Promise<EffectsExecuteResult>;
}

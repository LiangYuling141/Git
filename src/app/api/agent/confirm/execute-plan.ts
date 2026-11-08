import type { TaskStatus } from '@/tef/types';

/**
 * 人工批准后该调用哪个执行工具。
 *
 * 令牌与快照由契约决定，但工具名决定幂等命名空间与审计事件名。
 * 抽成纯函数，避免路由里出现两处 if 分支。
 */
export interface ExecutionPlan {
  tool: 'order.execute_create' | 'order.execute_compensate';
  successStatus: Extract<TaskStatus, 'completed' | 'compensated'>;
}

export function resolveExecutionPlan(contractOperation: string | undefined): ExecutionPlan {
  return contractOperation === 'compensate_order'
    ? { tool: 'order.execute_compensate', successStatus: 'compensated' }
    : { tool: 'order.execute_create', successStatus: 'completed' };
}

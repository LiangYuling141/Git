import type { Envelope, TaskStatus } from '@/tef/types';

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

/**
 * 执行结果 → 确认页状态。
 *
 * 关键分支是 `EXECUTION_IN_PROGRESS` / `EXECUTION_UNKNOWN`：副作用可能已经
 * 发生，必须保留 pending 预览与幂等键，提示用户用同一确认操作重试。若像普通
 * 失败那样清空 pending，用户重新预览会生成新的幂等键，可能产生第二次副作用。
 */
export interface ConfirmationOutcome {
  nextStatus: TaskStatus;
  reply: string;
  /** false：执行结果待对账，保留 pending 字段与幂等键，不清空任务。 */
  clearPending: boolean;
  activeOrderId: string | null;
}

export const EXECUTION_PENDING_REPLY = '执行结果待对账，请稍后使用同一确认操作重试；不要重新预览。';

const EXECUTION_PENDING_CODES: ReadonlySet<string> = new Set([
  'EXECUTION_IN_PROGRESS',
  'EXECUTION_UNKNOWN',
]);

export function resolveConfirmationOutcome(
  executed: Envelope,
  plan: ExecutionPlan,
  contractOperation: string,
): ConfirmationOutcome {
  const data = (executed.data ?? {}) as Record<string, unknown>;
  const activeOrderId = (data.orderId as string | undefined) ?? null;

  if (executed.error?.code && EXECUTION_PENDING_CODES.has(executed.error.code)) {
    return {
      nextStatus: 'executing',
      reply: EXECUTION_PENDING_REPLY,
      clearPending: false,
      activeOrderId: null,
    };
  }

  if (executed.status === 'ok') {
    const reply =
      contractOperation === 'compensate_order'
        ? [
            '已批准并执行补偿。订单已取消，收款计划已作废，库存与信用额度已恢复。',
            `审计事件 ${String(executed.auditId ?? '')}`,
          ].join('\n')
        : [
            '已批准并执行。',
            `订单 ${String(data.orderNo ?? '')}：总额 ¥${Number(data.totalAmount ?? 0).toFixed(2)}，定金 ¥${Number(
              data.deposit ?? 0,
            ).toFixed(2)}，余款 ¥${Number(data.balance ?? 0).toFixed(2)}（${String(data.termsDays ?? 0)} 天账期）`,
            `审计事件 ${String(executed.auditId ?? '')}`,
          ].join('\n');
    return { nextStatus: plan.successStatus, reply, clearPending: true, activeOrderId };
  }

  if (executed.status === 'conflict') {
    return {
      nextStatus: 'conflict',
      reply: `已批准，但执行时发生冲突，未产生写入：${executed.error?.message ?? ''}\n旧令牌已作废，请重新预览。`,
      clearPending: true,
      activeOrderId,
    };
  }

  return {
    nextStatus: 'failed',
    reply: `已批准，但执行失败：${executed.error?.message ?? ''}`,
    clearPending: true,
    activeOrderId,
  };
}

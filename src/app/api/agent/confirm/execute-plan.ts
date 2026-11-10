import { executionToolFor } from '@lymtrix/tef-runtime/runtime';
import type { Envelope, ErrorCode, TaskStatus } from '@/tef/types';

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

/**
 * 契约白名单与 Runtime 共用同一份映射（`executionToolFor`），避免路由里的
 * 重试白名单和 Runtime 的工具选择漂移。未知契约一律 fail closed。
 */
export function isExecutableContract(contract: string | null | undefined): contract is string {
  return typeof contract === 'string' && executionToolFor(contract) !== null;
}

export function resolveExecutionPlan(contractOperation: string | undefined): ExecutionPlan | null {
  const tool = contractOperation ? executionToolFor(contractOperation) : null;
  if (tool === 'order.execute_create') {
    return { tool, successStatus: 'completed' };
  }
  if (tool === 'order.execute_compensate') {
    return { tool, successStatus: 'compensated' };
  }
  // 未知契约 fail closed：绝不能把不认识的契约默认当成 create_order。
  return null;
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
  /**
   * 未结算执行的显式标记。非空时确认路由跳过 confirmation.approve，
   * 直接用同一幂等键重试执行；确定结果时必须为 null。
   */
  pendingExecutionAttemptId: string | null;
}

export const EXECUTION_PENDING_REPLY = '执行结果待对账，请稍后使用同一确认操作重试；不要重新预览。';

const EXECUTION_PENDING_CODES: ReadonlySet<ErrorCode> = new Set([
  'EXECUTION_IN_PROGRESS',
  'EXECUTION_UNKNOWN',
]);

export function resolveConfirmationOutcome(
  executed: Envelope,
  plan: ExecutionPlan,
  contractOperation: string,
  idempotencyKey?: string,
): ConfirmationOutcome {
  const data = (executed.data ?? {}) as Record<string, unknown>;
  const activeOrderId = (data.orderId as string | undefined) ?? null;

  if (executed.error?.code && EXECUTION_PENDING_CODES.has(executed.error.code)) {
    // 没有 attemptId 时用与幂等键绑定的哨兵值：只要 key 不变，标记就能表达
    // “这笔尝试仍未结算”，从而阻止下一轮解析新意图或换 key。
    const attemptId =
      typeof data.attemptId === 'string' && data.attemptId
        ? data.attemptId
        : idempotencyKey
          ? `pending:${idempotencyKey}`
          : null;
    return {
      nextStatus: 'executing',
      reply: EXECUTION_PENDING_REPLY,
      clearPending: false,
      activeOrderId: null,
      pendingExecutionAttemptId: attemptId,
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
    return {
      nextStatus: plan.successStatus,
      reply,
      clearPending: true,
      activeOrderId,
      pendingExecutionAttemptId: null,
    };
  }

  if (executed.status === 'conflict') {
    return {
      nextStatus: 'conflict',
      reply: `已批准，但执行时发生冲突，未产生写入：${executed.error?.message ?? ''}\n旧令牌已作废，请重新预览。`,
      clearPending: true,
      activeOrderId,
      pendingExecutionAttemptId: null,
    };
  }

  return {
    nextStatus: 'failed',
    reply: `已批准，但执行失败：${executed.error?.message ?? ''}`,
    clearPending: true,
    activeOrderId,
    pendingExecutionAttemptId: null,
  };
}

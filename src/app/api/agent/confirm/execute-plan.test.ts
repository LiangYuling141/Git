import { describe, expect, it } from 'vitest';
import type { Envelope } from '@/tef/types';
import { resolveConfirmationOutcome, resolveExecutionPlan, type ExecutionPlan } from './execute-plan';

/** 已知契约必须有计划；用断言收窄类型，失败时直接暴露契约映射回归。 */
function planFor(contract: string): ExecutionPlan {
  const plan = resolveExecutionPlan(contract);
  if (!plan) throw new Error(`expected an execution plan for ${contract}`);
  return plan;
}

describe('确认路由的执行计划', () => {
  it('创建订单 → order.execute_create，成功后 completed', () => {
    expect(resolveExecutionPlan('create_order')).toEqual({
      tool: 'order.execute_create',
      successStatus: 'completed',
    });
  });

  it('未知或缺失契约 fail closed：返回 null，不默认创建订单', () => {
    expect(resolveExecutionPlan(undefined)).toBeNull();
    expect(resolveExecutionPlan('')).toBeNull();
    expect(resolveExecutionPlan('refund_order')).toBeNull();
    expect(resolveExecutionPlan('constructor')).toBeNull();
  });

  it('补偿订单 → order.execute_compensate，成功后 compensated', () => {
    expect(resolveExecutionPlan('compensate_order')).toEqual({
      tool: 'order.execute_compensate',
      successStatus: 'compensated',
    });
  });
});

describe('确认路由的执行结果映射', () => {
  const createPlan = planFor('create_order');
  const compensatePlan = planFor('compensate_order');

  const pendingEnvelope = (code: 'EXECUTION_IN_PROGRESS' | 'EXECUTION_UNKNOWN'): Envelope => ({
    status: 'error',
    error: { code, message: 'execution state is not settled' },
    data: { attemptId: 'att_1', retryWithSameKey: true },
  });

  it.each(['EXECUTION_IN_PROGRESS', 'EXECUTION_UNKNOWN'] as const)(
    '%s → executing，保留 pending 与幂等键，提示用同一确认操作重试',
    (code) => {
      const outcome = resolveConfirmationOutcome(pendingEnvelope(code), createPlan, 'create_order');

      expect(outcome.nextStatus).toBe('executing');
      // false 表示路由只更新 status + idempotencyKey + marker，不清空 pending 字段。
      expect(outcome.clearPending).toBe(false);
      expect(outcome.pendingExecutionAttemptId).toBe('att_1');
      expect(outcome.reply).toContain('待对账');
      expect(outcome.reply).toContain('同一确认操作');
      expect(outcome.reply).toContain('不要重新预览');
    },
  );

  it('未知结果缺少 attemptId 时，用与幂等键绑定的哨兵 marker', () => {
    const outcome = resolveConfirmationOutcome(
      { status: 'error', error: { code: 'EXECUTION_IN_PROGRESS', message: 'in progress' } },
      createPlan,
      'create_order',
      'idem_retry',
    );

    expect(outcome.nextStatus).toBe('executing');
    expect(outcome.clearPending).toBe(false);
    expect(outcome.pendingExecutionAttemptId).toBe('pending:idem_retry');
  });

  it('成功后按计划标记 completed，并清空 pending', () => {
    const outcome = resolveConfirmationOutcome(
      {
        status: 'ok',
        data: { orderId: 'o_1', orderNo: 'SO-1', totalAmount: 200, deposit: 0, balance: 200, termsDays: 0 },
        auditId: 'aud_1',
      },
      createPlan,
      'create_order',
    );

    expect(outcome.nextStatus).toBe('completed');
    expect(outcome.clearPending).toBe(true);
    expect(outcome.pendingExecutionAttemptId).toBeNull();
    expect(outcome.activeOrderId).toBe('o_1');
    expect(outcome.reply).toContain('已批准并执行');
    expect(outcome.reply).toContain('SO-1');
  });

  it('补偿成功标记 compensated', () => {
    const outcome = resolveConfirmationOutcome(
      { status: 'ok', data: { orderId: 'o_1' }, auditId: 'aud_1' },
      compensatePlan,
      'compensate_order',
    );

    expect(outcome.nextStatus).toBe('compensated');
    expect(outcome.clearPending).toBe(true);
    expect(outcome.reply).toContain('已批准并执行补偿');
  });

  it('业务冲突映射为 conflict，确定性失败映射为 failed，二者都清空 pending', () => {
    const conflictOutcome = resolveConfirmationOutcome(
      { status: 'conflict', error: { code: 'CONFLICT', message: 'stock changed' } },
      createPlan,
      'create_order',
    );
    expect(conflictOutcome.nextStatus).toBe('conflict');
    expect(conflictOutcome.clearPending).toBe(true);
    expect(conflictOutcome.pendingExecutionAttemptId).toBeNull();
    expect(conflictOutcome.reply).toContain('未产生写入');

    const failedOutcome = resolveConfirmationOutcome(
      { status: 'error', error: { code: 'INTERNAL', message: 'database exploded' } },
      createPlan,
      'create_order',
    );
    expect(failedOutcome.nextStatus).toBe('failed');
    expect(failedOutcome.clearPending).toBe(true);
    expect(failedOutcome.pendingExecutionAttemptId).toBeNull();
    expect(failedOutcome.reply).toContain('执行失败');
  });
});

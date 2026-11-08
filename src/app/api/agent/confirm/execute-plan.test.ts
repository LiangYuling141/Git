import { describe, expect, it } from 'vitest';
import { resolveExecutionPlan } from './execute-plan';

describe('确认路由的执行计划', () => {
  it('创建订单 → order.execute_create，成功后 completed', () => {
    expect(resolveExecutionPlan('create_order')).toEqual({
      tool: 'order.execute_create',
      successStatus: 'completed',
    });
  });

  it('缺省契约按创建订单处理', () => {
    expect(resolveExecutionPlan(undefined)).toEqual({
      tool: 'order.execute_create',
      successStatus: 'completed',
    });
  });

  it('补偿订单 → order.execute_compensate，成功后 compensated', () => {
    expect(resolveExecutionPlan('compensate_order')).toEqual({
      tool: 'order.execute_compensate',
      successStatus: 'compensated',
    });
  });
});

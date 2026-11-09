import { describe, expect, it } from 'vitest';
import type { PrismaTx } from '../prisma';
import { settlementRacedEnvelope } from './contract';

/**
 * 条件结算竞争的响应优先级（直接单测，不依赖数据库）。
 *
 * updateMany 命中 0 行说明另一个调用者已经推进终态。此时必须：
 * 1. 优先重放已提交的幂等记录；
 * 2. 其次重放 attempt 中存储的结果；
 * 3. attempt 仍未结算时返回 EXECUTION_IN_PROGRESS / EXECUTION_UNKNOWN，
 *    绝不能泛化成 CONFLICT 诱导调用方换 key；
 * 4. 没有任何记录时才要求人工对账。
 */

interface FakeRows {
  record?: unknown;
  attempt?: unknown;
}

function fakeTx(rows: FakeRows): PrismaTx {
  return {
    idempotencyRecord: {
      findFirst: async () => rows.record ?? null,
    },
    executionAttempt: {
      findFirst: async () => rows.attempt ?? null,
    },
  } as unknown as PrismaTx;
}

function racedEnvelope(rows: FakeRows) {
  return settlementRacedEnvelope(
    fakeTx(rows),
    't_yiwu_demo',
    'order.execute_create',
    'idem_retry',
    'att_1',
    'tr_test',
  );
}

describe('settlementRacedEnvelope', () => {
  it('优先重放已提交的幂等记录', async () => {
    const envelope = await racedEnvelope({
      record: { response: { status: 'ok', data: { orderId: 'o_1', idempotencyKey: 'idem_retry' } } },
      attempt: { attemptId: 'att_1', status: 'executing', result: null, traceId: 'tr_test' },
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.data).toMatchObject({ orderId: 'o_1', replayed: true });
  });

  it('没有幂等记录时重放 attempt 中存储的结果', async () => {
    const envelope = await racedEnvelope({
      attempt: {
        attemptId: 'att_1',
        status: 'succeeded',
        result: { status: 'ok', data: { orderId: 'o_stored' } },
        traceId: 'tr_test',
      },
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.data).toMatchObject({ orderId: 'o_stored', replayed: true });
  });

  it.each([
    ['executing', 'EXECUTION_IN_PROGRESS'],
    ['unknown', 'EXECUTION_UNKNOWN'],
  ] as const)('attempt 仍为 %s 时返回 %s，而不是泛化 CONFLICT', async (status, code) => {
    const envelope = await racedEnvelope({
      attempt: { attemptId: 'att_1', status, result: null, traceId: 'tr_test' },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error?.code).toBe(code);
    expect(envelope.data).toMatchObject({ attemptId: 'att_1', retryWithSameKey: true });
  });

  it('没有任何记录与尝试时要求人工对账', async () => {
    const envelope = await racedEnvelope({});

    expect(envelope.status).toBe('conflict');
    expect(envelope.error?.code).toBe('CONFLICT');
    expect(envelope.error?.message).toContain('settled concurrently');
  });
});

/**
 * 确认卡片的结算映射。
 *
 * executing（EXECUTION_IN_PROGRESS / EXECUTION_UNKNOWN）不是确定结果：
 * 服务端可能仍在执行或等待对账，卡片必须保持未决，让用户对同一操作再次确认。
 * 这个判断必须先于 action/status 映射——尤其是拒绝：未结算期间拒绝并不会
 * 撤销可能已经发生的副作用，不能把卡片标成"已拒绝"。
 */
export type ConfirmResolution = 'executed' | 'rejected' | 'conflict' | 'failed';

export interface CardResolutionInput {
  ok: boolean;
  action: 'approve' | 'reject';
  status?: string;
}

export function resolveCardResolution(input: CardResolutionInput): ConfirmResolution | undefined {
  if (!input.ok || input.status === 'executing') return undefined;
  if (input.action === 'reject') return 'rejected';

  switch (input.status) {
    case 'completed':
    case 'compensated':
      return 'executed';
    case 'conflict':
      return 'conflict';
    case 'failed':
    case 'compensation_failed':
      return 'failed';
    default:
      return undefined;
  }
}

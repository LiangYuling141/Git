import { contractRegistry } from '@lymtrix/tef-core';
import {
  COMPENSATE_ORDER_OPERATION,
  COMPENSATE_ORDER_VERSION,
  compensateOrderContract,
} from './compensate-order';
import { CREATE_ORDER_OPERATION, CREATE_ORDER_VERSION, createOrderContract } from './create-order';

export { createCreditOrderAdapters, type CreditOrderMeta } from './adapters';
export {
  COMPENSATE_ORDER_OPERATION,
  COMPENSATE_ORDER_VERSION,
  compensateOrderContract,
} from './compensate-order';
export { CREATE_ORDER_OPERATION, CREATE_ORDER_VERSION, createOrderContract } from './create-order';
export {
  compensateOrderRawSchema,
  compensateOrderParamsSchema,
  createOrderRawSchema,
  createOrderParamsSchema,
  type CompensateOrderEvidence,
  type CompensateOrderParams,
  type CreateOrderEvidence,
  type CreateOrderParams,
  type CustomerEvidence,
  type OrderEvidence,
  type PaymentEvidence,
  type PaymentRole,
  type ProductEvidence,
} from './types';

let registered = false;

/** 注册义乌赊账订单垂直的全部契约。重复调用是安全的。 */
export function registerCreditOrderContracts(): void {
  if (registered) return;
  contractRegistry.register(createOrderContract);
  contractRegistry.register(compensateOrderContract);
  registered = true;
}

export const CREDIT_ORDER_CONTRACTS = [
  { operation: CREATE_ORDER_OPERATION, version: CREATE_ORDER_VERSION },
  { operation: COMPENSATE_ORDER_OPERATION, version: COMPENSATE_ORDER_VERSION },
] as const;

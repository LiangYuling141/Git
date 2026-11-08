import { contractRegistry } from '@/tef/contract-registry';
import { CREATE_ORDER_OPERATION, CREATE_ORDER_VERSION, createOrderContract } from './create-order';

export { createCreditOrderAdapters, type CreditOrderMeta } from './adapters';
export { CREATE_ORDER_OPERATION, CREATE_ORDER_VERSION, createOrderContract } from './create-order';
export {
  createOrderRawSchema,
  createOrderParamsSchema,
  type CreateOrderEvidence,
  type CreateOrderParams,
  type CustomerEvidence,
  type ProductEvidence,
} from './types';

let registered = false;

/** 注册义乌赊账订单垂直的全部契约。重复调用是安全的。 */
export function registerCreditOrderContracts(): void {
  if (registered) return;
  contractRegistry.register(createOrderContract);
  registered = true;
}

export const CREDIT_ORDER_CONTRACTS = [
  { operation: CREATE_ORDER_OPERATION, version: CREATE_ORDER_VERSION },
] as const;

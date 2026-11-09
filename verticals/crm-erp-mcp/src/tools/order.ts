import type { Envelope } from '@lymatrix/tef-core';
import {
  executeContract,
  previewContract,
  type ContractWriteOptions,
  type Principal,
  type PrismaTx,
} from '@lymatrix/tef-mcp-kit';
import { createCreditOrderAdapters, registerCreditOrderContracts } from '../contracts/credit-order';

/**
 * 赊账订单垂直的两个写入操作：
 * - create_order：创建赊账订单；
 * - compensate_order：撤销已提交订单。
 *
 * 这里只做垂直绑定（契约名、工具名、适配器），通用协议在 ./contract.ts。
 * 公理 I3：执行工具只接受 confirmation_token + idempotency_key。
 */

registerCreditOrderContracts();

export type WriteOptions = ContractWriteOptions;

export function orderPreviewCreate(
  principal: Principal,
  args: Record<string, unknown>,
  options: WriteOptions,
): Promise<Envelope> {
  return previewContract(principal, 'create_order', args, options, 'order.preview_create');
}

export function orderExecuteCreate(
  principal: Principal,
  args: { confirmation_token?: string; idempotency_key?: string },
  options: WriteOptions,
): Promise<Envelope> {
  return executeContract(
    principal,
    args,
    options,
    'order.execute_create',
    'create_order',
    'failure',
    createCreditOrderAdapters,
  );
}

export function orderPreviewCompensate(
  principal: Principal,
  args: Record<string, unknown>,
  options: WriteOptions,
): Promise<Envelope> {
  return previewContract(principal, 'compensate_order', args, options, 'order.preview_compensate');
}

export function orderExecuteCompensate(
  principal: Principal,
  args: { confirmation_token?: string; idempotency_key?: string },
  options: WriteOptions,
): Promise<Envelope> {
  return executeContract(
    principal,
    args,
    options,
    'order.execute_compensate',
    'compensate_order',
    'compensation_failed',
    createCreditOrderAdapters,
  );
}

export type { PrismaTx };

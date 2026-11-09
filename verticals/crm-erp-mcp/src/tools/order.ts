import type { Envelope } from '@lymtrix/tef-core';
import {
  executeContract,
  previewContract,
  type ContractToolOptions,
  type ContractWriteOptions,
  type Principal,
  type PrismaTx,
} from '@lymtrix/tef-mcp-kit';
import { registerCreditOrderContracts } from '../contracts/credit-order';
import { createInProcessCrmEffectsExecutor } from '../gateway/effects-executor';
import { createCrmGateway } from '../gateway/factory';

/**
 * 赊账订单垂直的两个写入操作：
 * - create_order：创建赊账订单；
 * - compensate_order：撤销已提交订单。
 *
 * 这里只做垂直绑定（契约名、工具名、适配器、副作用执行器），通用协议在
 * packages/tef-mcp-kit。公理 I3：执行工具只接受 confirmation_token + idempotency_key。
 *
 * Phase C：状态机通过 EffectsExecutor 端口执行副作用。默认注入进程内 CRM
 * 执行器；调用方显式传入执行器时保留覆盖（例如跨服务 HTTP 执行器）。
 */

registerCreditOrderContracts();

export type WriteOptions = ContractToolOptions;

function withEffectsExecutor(options: WriteOptions): ContractWriteOptions {
  return {
    ...options,
    effectsExecutor: options.effectsExecutor ?? createInProcessCrmEffectsExecutor(),
  };
}

export function orderPreviewCreate(
  principal: Principal,
  args: Record<string, unknown>,
  options: WriteOptions,
): Promise<Envelope> {
  return previewContract(
    principal,
    'create_order',
    args,
    { ...withEffectsExecutor(options), gatewayFactory: options.gatewayFactory ?? createCrmGateway },
    'order.preview_create',
  );
}

export function orderExecuteCreate(
  principal: Principal,
  args: { confirmation_token?: string; idempotency_key?: string },
  options: WriteOptions,
): Promise<Envelope> {
  return executeContract(
    principal,
    args,
    { ...withEffectsExecutor(options), gatewayFactory: options.gatewayFactory ?? createCrmGateway },
    'order.execute_create',
    'create_order',
    'failure',
  );
}

export function orderPreviewCompensate(
  principal: Principal,
  args: Record<string, unknown>,
  options: WriteOptions,
): Promise<Envelope> {
  return previewContract(
    principal,
    'compensate_order',
    args,
    { ...withEffectsExecutor(options), gatewayFactory: options.gatewayFactory ?? createCrmGateway },
    'order.preview_compensate',
  );
}

export function orderExecuteCompensate(
  principal: Principal,
  args: { confirmation_token?: string; idempotency_key?: string },
  options: WriteOptions,
): Promise<Envelope> {
  return executeContract(
    principal,
    args,
    { ...withEffectsExecutor(options), gatewayFactory: options.gatewayFactory ?? createCrmGateway },
    'order.execute_compensate',
    'compensate_order',
    'compensation_failed',
  );
}

export type { PrismaTx };

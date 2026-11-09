import type { Prisma } from '@/generated/prisma';
import { TefError, MAX_CLARIFICATION_ROUNDS, type IntentResult, type TaskState, type TaskStatus } from '@lymtrix/tef-core';
import { withTenantScope } from '@lymtrix/tef-mcp-kit/tenant-scope';

/**
 * TaskState 存储（§8）。
 *
 * 对话上下文只保存"说了什么"，任务进行到哪一步只存在这里（§8.3）。
 * 服务崩溃后从 TaskState 与事件日志重建，不依赖客户端存储。
 *
 * 这属于 L2 会话层的服务端基础设施，由 API 路由调用——
 * 不是 Agent Runtime 的一部分，Runtime 只拿到序列化后的 TaskState 数据。
 */

export interface TaskStatePatch {
  status?: TaskStatus;
  intent?: IntentResult | null;
  pendingPreviewId?: string | null;
  pendingIntentHash?: string | null;
  pendingContract?: string | null;
  pendingContractVersion?: string | null;
  pendingExpiresAt?: Date | null;
  activeCustomerId?: string | null;
  activeOrderId?: string | null;
  idempotencyKey?: string | null;
  pendingExecutionAttemptId?: string | null;
  pendingConfirmationToken?: string | null;
  clarificationRounds?: number;
  traceId?: string | null;
}

type Row = {
  id: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  status: TaskStatus;
  intent: Prisma.JsonValue | null;
  pendingPreviewId: string | null;
  pendingIntentHash: string | null;
  pendingContract: string | null;
  pendingContractVersion: string | null;
  pendingExpiresAt: Date | null;
  activeCustomerId: string | null;
  activeOrderId: string | null;
  idempotencyKey: string | null;
  pendingExecutionAttemptId: string | null;
  pendingConfirmationToken: string | null;
  clarificationRounds: number;
  version: number;
  traceId: string | null;
  updatedAt: Date;
};

function toTaskState(row: Row): TaskState {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    conversationId: row.conversationId,
    status: row.status,
    intent: (row.intent as IntentResult | null) ?? null,
    pendingPreview: row.pendingPreviewId
      ? {
          previewId: row.pendingPreviewId,
          intentHash: row.pendingIntentHash ?? '',
          contract: row.pendingContract ?? '',
          contractVersion: row.pendingContractVersion ?? '',
          expiresAt: row.pendingExpiresAt ?? new Date(0),
        }
      : null,
    activeCustomerId: row.activeCustomerId,
    activeOrderId: row.activeOrderId,
    idempotencyKey: row.idempotencyKey,
    pendingExecutionAttemptId: row.pendingExecutionAttemptId,
    pendingConfirmationToken: row.pendingConfirmationToken,
    clarificationRounds: row.clarificationRounds,
    version: row.version,
    traceId: row.traceId,
    updatedAt: row.updatedAt,
  };
}

export class TaskStateStore {
  async loadOrCreate(tenantId: string, conversationId: string, userId: string): Promise<TaskState> {
    return withTenantScope(tenantId, async (tx) => {
      const existing = await tx.taskState.findFirst({ where: { tenantId, conversationId } });
      if (existing) return toTaskState(existing);
      const created = await tx.taskState.create({
        data: { tenantId, conversationId, userId, status: 'idle', version: 0, clarificationRounds: 0 },
      });
      return toTaskState(created);
    });
  }

  async load(tenantId: string, conversationId: string): Promise<TaskState | null> {
    return withTenantScope(tenantId, async (tx) => {
      const row = await tx.taskState.findFirst({ where: { tenantId, conversationId } });
      return row ? toTaskState(row) : null;
    });
  }

  /**
   * 乐观锁更新：version 不匹配说明有并发写入，返回 CONFLICT 让调用方重读。
   * 聊天记录不是事实源，TaskState 才是，所以它必须能被安全地并发修正。
   */
  async update(
    tenantId: string,
    conversationId: string,
    patch: TaskStatePatch,
    expectedVersion: number,
  ): Promise<TaskState> {
    return withTenantScope(tenantId, async (tx) => {
      const result = await tx.taskState.updateMany({
        where: { tenantId, conversationId, version: expectedVersion },
        data: { ...patch, version: expectedVersion + 1 } as never,
      });
      if (result.count !== 1) {
        throw new TefError('CONFLICT', `task state for conversation ${conversationId} was modified concurrently`);
      }
      const row = await tx.taskState.findFirst({ where: { tenantId, conversationId } });
      if (!row) throw new TefError('INTERNAL', 'task state vanished after update');
      return toTaskState(row);
    });
  }

  /** 澄清轮次超限则终止任务（§7.3：默认上限 3 轮）。 */
  static canClarifyMore(rounds: number): boolean {
    return rounds < MAX_CLARIFICATION_ROUNDS;
  }
}

export const taskStateStore = new TaskStateStore();

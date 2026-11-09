/**
 * 执行状态机（Phase C）。
 *
 * 两阶段执行：预审计 → 副作用（按幂等键）→ 结果审计。
 * `executing` / `unknown` 表示副作用可能已经发生，必须由对账按同一幂等键收敛，
 * 不允许直接重试生成新的副作用。
 */

export type ExecutionStatus = 'executing' | 'succeeded' | 'failed' | 'unknown';

/** 与 Prisma `execution_attempts` 表对应的框架级记录。 */
export interface ExecutionAttemptRecord {
  attemptId: string;
  tenantId: string;
  traceId: string;
  previewId: string;
  contract: string;
  contractVersion: string;
  intentHash: string;
  toolName: string;
  idempotencyKey: string;
  status: ExecutionStatus;
  risk: string;
  effects: unknown[];
  expectedEvidenceVersion?: string | null;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  preAuditEventId?: string | null;
  resultAuditEventId?: string | null;
}

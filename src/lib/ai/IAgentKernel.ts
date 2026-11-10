// =============================================================================
// Agent Kernel Interface
// =============================================================================

import { z } from 'zod';
import type { Operation, Session } from '@/types';

/**
 * 子 Agent 的模型输出契约。模型处于不可信域，`passed` 必须是布尔值：
 * 任何字符串、数字或缺省都会让校验失败，避免 `"yes"` 之类的真值被当成通过。
 */
export const validationResultSchema = z.object({
  passed: z.boolean(),
  reason: z.string().optional(),
  riskPoints: z.array(z.string()).optional(),
});

export type ValidationResult = z.infer<typeof validationResultSchema>;

export function parseValidationResult(content: string): ValidationResult {
  return validationResultSchema.parse(JSON.parse(content));
}

export interface IAgentKernel {
  vote(operation: Operation, session: Session): Promise<'approve' | 'reject'>;
  getReason(): string;
}

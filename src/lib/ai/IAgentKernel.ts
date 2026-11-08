// =============================================================================
// Agent Kernel Interface
// =============================================================================

import type { Operation, Session } from '@/types';

export interface ValidationResult {
  passed: boolean;
  reason?: string;
  riskPoints?: string[];
}

export interface IAgentKernel {
  vote(operation: Operation, session: Session): Promise<'approve' | 'reject'>;
  getReason(): string;
}

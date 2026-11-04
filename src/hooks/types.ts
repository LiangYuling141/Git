// =============================================================================
// Hook System Types
// =============================================================================

import type { Customer, Operation, RiskLevel, Session, ToolCall } from '@/types';

export type HookType =
  | 'pre_processing'
  | 'pre_agent'
  | 'post_agent'
  | 'stop'
  | 'pre_tool'
  | 'post_tool'
  | 'post_execution'
  | 'on_error';

export interface HookResult {
  status: 'allow' | 'block' | 'warn' | 'modify';
  message?: string;
  warnings?: string[];
  allowRetry: boolean;
  modifiedData?: unknown;
}

export interface HookContext {
  phase: HookType;
  userInput?: string;
  aiOutput?: string;
  operation?: Operation;
  riskLevel?: RiskLevel;
  customer?: Customer;
  session: Session;
  toolCall?: ToolCall;
  metadata: Record<string, unknown>;
}

export interface Hook {
  name: string;
  type: HookType;
  priority: number;
  enabledByDefault: boolean;
  condition?: (context: HookContext) => boolean | Promise<boolean>;
  execute(context: HookContext): HookResult | Promise<HookResult>;
}

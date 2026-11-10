import type { RiskOutcome } from '@lymtrix/tef-core';
import type { TokenUsage } from '@lymtrix/tef-runtime';
import type { EvalSample } from './sample';

export type Decision = 'allow' | 'confirm' | 'block' | 'clarify' | 'error';

export interface ActualOutcome {
  decision: Decision;
  contract: string | null;
  slots: Record<string, unknown>;
  risk: RiskOutcome | null;
  code?: string;
  reasons: string[];
}

export interface SampleOutcome {
  sampleId: string;
  category: EvalSample['category'];
  expected: EvalSample['expect'];
  actual: ActualOutcome;
  intentSource: 'annotated' | 'deterministic' | 'model' | 'none';
  skipped?: 'multi_turn' | 'non_contract';
  latencyMs: number;
  /** 端到端层的模型用量；离线层为空。 */
  usage?: TokenUsage[];
  /** 端到端层按价目快照计算的成本；无 usage 时为 null。 */
  cost?: number | null;
}

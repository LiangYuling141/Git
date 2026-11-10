import {
  contractEngine,
  contractRegistry,
  ContractValidationError,
  type ExecContext,
  type RiskOutcome,
} from '@lymtrix/tef-core';
import { parseIntentDeterministic } from '@lymtrix/tef-runtime';
import { ZodError } from 'zod';
import { registerCreditOrderContracts } from '@lymtrix/vertical-crm-erp';
import { FixtureCrmGateway } from './fixtures';
import type { EvalSample } from './sample';
import type { ActualOutcome, Decision, SampleOutcome } from './outcome';

registerCreditOrderContracts();

const DEFAULT_NOW = '2026-01-01T00:00:00.000Z';

function decisionFor(blocked: boolean, risk: RiskOutcome): Decision {
  if (blocked) return 'block';
  return risk === 'L2' ? 'confirm' : 'allow';
}

/** 参数归一化失败（含契约 normalize 内抛出的 ZodError）统一转澄清。 */
function invalidArgReasons(error: ContractValidationError | ZodError): string[] {
  if (error instanceof ContractValidationError) {
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

export async function runOfflineSample(sample: EvalSample): Promise<SampleOutcome> {
  const started = performance.now();
  // 离线层不写治理表，但 traceId 是契约执行的确定性标识，结果中保留以便与
  // 端到端层及审计回放对齐。
  const traceId = `tr_eval_${sample.id}`;

  if (sample.input.messages.length > 1) {
    return {
      sampleId: sample.id,
      category: sample.category,
      expected: sample.expect,
      actual: {
        decision: 'error',
        contract: null,
        slots: {},
        risk: null,
        reasons: ['multi-turn sample is not evaluated offline'],
      },
      intentSource: 'none',
      skipped: 'multi_turn',
      latencyMs: performance.now() - started,
      traceId,
    };
  }

  let intent = sample.intent;
  let intentSource: SampleOutcome['intentSource'] = 'annotated';
  if (!intent) {
    const parsed = parseIntentDeterministic(sample.input.messages[0]);
    intentSource = 'deterministic';
    if (parsed.kind === 'operation') {
      intent = { contract: parsed.contract, slots: parsed.slots };
    } else if (parsed.kind === 'clarify') {
      return {
        sampleId: sample.id,
        category: sample.category,
        expected: sample.expect,
        actual: {
          decision: 'clarify',
          contract: parsed.contract ?? null,
          slots: parsed.slots ?? {},
          risk: null,
          reasons: parsed.questions.map((question) => `${question.slot}:${question.reason}`),
        },
        intentSource,
        latencyMs: performance.now() - started,
        traceId,
      };
    } else if (parsed.kind === 'chat') {
      // 聊天回复不是写入放行：解析器没有形成可执行操作，需要用户补充信息。
      return {
        sampleId: sample.id,
        category: sample.category,
        expected: sample.expect,
        actual: {
          decision: 'clarify',
          contract: null,
          slots: {},
          risk: null,
          reasons: ['deterministic parser returned chat; input needs clarification'],
        },
        intentSource,
        latencyMs: performance.now() - started,
        traceId,
      };
    } else {
      // compound 是多步意图，离线层不拆分执行；也不能冒充 chat。
      return {
        sampleId: sample.id,
        category: sample.category,
        expected: sample.expect,
        actual: {
          decision: 'clarify',
          contract: null,
          slots: {},
          risk: null,
          reasons: ['deterministic parser returned compound; multi-step input requires decomposition'],
        },
        intentSource,
        latencyMs: performance.now() - started,
        traceId,
      };
    }
  }

  const contract = contractRegistry.get(intent.contract);
  if (!contract) {
    // 查询工具没有契约，只在端到端层评测。
    return {
      sampleId: sample.id,
      category: sample.category,
      expected: sample.expect,
      actual: {
        decision: 'error',
        contract: intent.contract,
        slots: intent.slots,
        risk: null,
        code: 'NON_CONTRACT_OPERATION',
        reasons: [`${intent.contract} is a query tool, not a contract`],
      },
      intentSource,
      skipped: 'non_contract',
      latencyMs: performance.now() - started,
      traceId,
    };
  }

  const ctx: ExecContext = {
    tenantId: `t_eval_${sample.id}`,
    userId: sample.principal.userId,
    sessionId: `s_eval_${sample.id}`,
    role: sample.principal.role,
    traceId,
    timestampSnapshot: new Date(sample.now ?? DEFAULT_NOW),
    recentOpCount: 0,
    whitelistLevel: 'none',
    tenantThresholds: sample.tenant.thresholds,
    db: undefined,
    gateway: new FixtureCrmGateway(sample.fixtures),
  };

  try {
    const outcome = await contractEngine.preview(contract, intent.slots, ctx);
    const actual: ActualOutcome = {
      decision: decisionFor(outcome.blocked, outcome.risk),
      contract: contract.operation,
      slots: outcome.params as Record<string, unknown>,
      risk: outcome.risk,
      code: outcome.failedChecks[0]?.code,
      reasons: outcome.reasons,
    };

    return {
      sampleId: sample.id,
      category: sample.category,
      expected: sample.expect,
      actual,
      intentSource,
      latencyMs: performance.now() - started,
      traceId,
    };
  } catch (error) {
    // 参数不完整时契约引擎会抛 ContractValidationError（内部包装 normalize 的
    // ZodError）；语义上应转澄清，而不是放行。裸 ZodError 作为防御性兜底。
    if (error instanceof ContractValidationError || error instanceof ZodError) {
      return {
        sampleId: sample.id,
        category: sample.category,
        expected: sample.expect,
        actual: {
          decision: 'clarify',
          contract: contract.operation,
          slots: intent.slots,
          risk: null,
          code: 'INVALID_ARGS',
          reasons: invalidArgReasons(error),
        },
        intentSource,
        latencyMs: performance.now() - started,
        traceId,
      };
    }
    throw error;
  }
}

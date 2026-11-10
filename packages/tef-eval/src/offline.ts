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
import { normalizeClarifySlots } from './slots';

registerCreditOrderContracts();

const DEFAULT_NOW = '2026-01-01T00:00:00.000Z';

/**
 * 已知的查询工具白名单。
 *
 * 离线层只评测已注册契约；这些工具没有契约，属于设计内的非契约操作，
 * 标记跳过而不是错误。未知 operation 则说明样本或契约注册出了问题，
 * 必须作为 `UNKNOWN_CONTRACT` 错误暴露，不能静默跳过。
 */
const KNOWN_QUERY_TOOLS = new Set([
  'credit.get',
  'inventory.check',
  'customer.search',
  'customer.get',
  'order.get',
  'whitelist.list',
  'tenant.config.get',
]);

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
        clarifySlots: [],
        reasons: ['multi-turn sample is not evaluated offline'],
      },
      intentSource: 'none',
      skipped: 'multi_turn',
      latencyMs: performance.now() - started,
      traceId,
    };
  }

  let intent = sample.intent;
  const intentSource: SampleOutcome['intentSource'] = intent ? 'annotated' : 'deterministic';
  if (!intent) {
    const parsed = parseIntentDeterministic(sample.input.messages[0]);
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
          clarifySlots: normalizeClarifySlots(parsed.questions.map((question) => question.slot)),
          reasons: parsed.questions.map((question) => `${question.slot}:${question.reason}`),
        },
        intentSource,
        latencyMs: performance.now() - started,
        traceId,
      };
    } else {
      // chat / compound 没有形成已注册契约操作。离线层只评测契约操作，
      // 不能把“解析器没产出操作”计为澄清成功或放行；标记跳过并保留原因。
      return {
        sampleId: sample.id,
        category: sample.category,
        expected: sample.expect,
        actual: {
          decision: 'clarify',
          contract: null,
          slots: {},
          risk: null,
          clarifySlots: [],
          reasons: [
            parsed.kind === 'chat'
              ? 'deterministic parser returned chat; offline layer only scores contract operations'
              : 'deterministic parser returned compound; offline layer only scores single contract operations',
          ],
        },
        intentSource,
        skipped: 'non_contract',
        latencyMs: performance.now() - started,
        traceId,
      };
    }
  }

  const contract = contractRegistry.get(intent.contract);
  if (!contract) {
    if (KNOWN_QUERY_TOOLS.has(intent.contract)) {
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
          clarifySlots: [],
          code: 'NON_CONTRACT_OPERATION',
          reasons: [`${intent.contract} is a query tool, not a contract`],
        },
        intentSource,
        skipped: 'non_contract',
        latencyMs: performance.now() - started,
        traceId,
      };
    }
    // 未知 operation 不是“查询工具”，而是样本或契约注册错误；必须计分暴露。
    return {
      sampleId: sample.id,
      category: sample.category,
      expected: sample.expect,
      actual: {
        decision: 'error',
        contract: intent.contract,
        slots: intent.slots,
        risk: null,
        clarifySlots: [],
        code: 'UNKNOWN_CONTRACT',
        reasons: [`${intent.contract} is neither a registered contract nor a known query tool`],
      },
      intentSource,
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
      clarifySlots: [],
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
          clarifySlots: [],
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

import { computeEvidenceDigest, computeIntentHash } from './hashing';
import type {
  AuditSpec,
  Check,
  Contract,
  DiffEntry,
  Effect,
  ExecContext,
  RiskOutcome,
} from './types';

/**
 * 契约引擎（§5）。
 *
 * 执行顺序固定：normalize → loadEvidence → permissions → preconditions → invariants
 * → riskRules → effects。任何一步产出 block 级 Check 失败即 Block，不再往下走。
 *
 * evidence 先行加载、Check 是纯函数（§5.2 约束 2）：Check 与 riskRules 都拿不到
 * 数据访问句柄，所以不可能有隐式 IO 或依赖排序问题，也能离线单测。
 */

export class ContractValidationError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}

export interface PreviewOutcome<P = unknown, EV = unknown> {
  blocked: boolean;
  params: P;
  evidence: EV;
  risk: RiskOutcome;
  reasons: string[];
  checks: Check[];
  failedChecks: Check[];
  effects: Effect[];
  diff: DiffEntry[];
  audit: AuditSpec;
  intentHash: string;
  evidenceDigest: string;
}

export type RevalidateOutcome<P = unknown, EV = unknown> =
  | {
      ok: true;
      params: P;
      evidence: EV;
      risk: RiskOutcome;
      reasons: string[];
      effects: Effect[];
      audit: AuditSpec;
      evidenceDigest: string;
    }
  | {
      ok: false;
      code: 'CONFLICT';
      /** 前置条件失效，还是风险升级要求重新确认（§12.2） */
      cause: 'precondition' | 'risk_escalation';
      reasons: string[];
      failedChecks: Check[];
    };

const RISK_ORDER: Record<RiskOutcome, number> = { L0: 0, L1: 1, L2: 2, Block: 3 };

function isBlocking(check: Check): boolean {
  return !check.ok && (check.severity ?? 'block') === 'block';
}

function collectChecks<P, EV, DB>(contract: Contract<P, EV, DB>, params: P, evidence: EV, ctx: ExecContext<DB>): Check[] {
  return [
    ...contract.permissions(params, ctx),
    ...contract.preconditions(params, evidence),
    ...contract.invariants(params, evidence),
  ];
}

/** 契约没提供 diff 时的兜底：直接把声明式 effects 摊开。 */
function deriveDiff(effects: Effect[]): DiffEntry[] {
  return effects.map((effect) => ({
    entity: effect.entity,
    action: effect.type,
    label: `${effect.type} ${effect.entity}${effect.as ? ` as ${effect.as}` : ''}`,
    payload: effect.type === 'create' ? effect.payload : undefined,
    changes: Object.entries(effect.increment ?? {}).map(([field, delta]) => ({ field, delta })),
  }));
}

function extractIssues(error: unknown): Array<{ path: string; message: string }> {
  const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> })?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    path: (issue.path ?? []).join('.'),
    message: issue.message ?? 'invalid',
  }));
}

export class ContractEngine {
  /**
   * 预览：不写库，只读证据 + 归一化参数，产出 diff / risk / reasons 与两层哈希。
   * 这是签发令牌的唯一入口。
   */
  async preview<P, EV, DB>(
    contract: Contract<P, EV, DB>,
    rawInput: unknown,
    ctx: ExecContext<DB>,
  ): Promise<PreviewOutcome<P, EV>> {
    const params = this.normalize(contract, rawInput);
    const evidence = await contract.loadEvidence(params, ctx);
    const evidenceDigest = computeEvidenceDigest(evidence);
    const intentHash = computeIntentHash({
      contract: contract.operation,
      contractVersion: contract.version,
      normalizedArgs: params,
    });

    const checks = collectChecks(contract, params, evidence, ctx);
    const failedChecks = checks.filter((check) => !check.ok);
    const blockedByCheck = checks.some(isBlocking);

    if (blockedByCheck) {
      return {
        blocked: true,
        params,
        evidence,
        risk: 'Block',
        reasons: failedChecks.filter(isBlocking).map((check) => `${check.code}: ${check.message}`),
        checks,
        failedChecks,
        effects: [],
        diff: [],
        audit: contract.audit(params, evidence, null),
        intentHash,
        evidenceDigest,
      };
    }

    const risk = contract.riskRules(params, evidence, ctx);
    if (risk.level === 'Block') {
      return {
        blocked: true,
        params,
        evidence,
        risk: 'Block',
        reasons: risk.reasons,
        checks,
        failedChecks,
        effects: [],
        diff: [],
        audit: contract.audit(params, evidence, null),
        intentHash,
        evidenceDigest,
      };
    }

    const effects = contract.effects(params, evidence);
    return {
      blocked: false,
      params,
      evidence,
      risk: risk.level,
      reasons: [...risk.reasons, ...failedChecks.map((check) => `warn ${check.code}: ${check.message}`)],
      checks,
      failedChecks,
      effects,
      diff: contract.diff ? contract.diff(params, evidence) : deriveDiff(effects),
      audit: contract.audit(params, evidence, null),
      intentHash,
      evidenceDigest,
    };
  }

  /**
   * 执行前重校验（§4 生命周期第 5 步、§12.2 冲突恢复）。
   *
   * 在事务内重新加载证据并重跑全部 Check：预览与执行之间可能有并发变动。
   * 前置条件失效 → CONFLICT，要求重新预览，不复用令牌。
   * 风险等级上升 → 同样是 CONFLICT，因为人批准的是原来那个等级。
   */
  async revalidate<P, EV, DB>(
    contract: Contract<P, EV, DB>,
    params: P,
    ctx: ExecContext<DB>,
    approvedRisk: RiskOutcome,
  ): Promise<RevalidateOutcome<P, EV>> {
    const evidence = await contract.loadEvidence(params, ctx);
    const checks = collectChecks(contract, params, evidence, ctx);
    const failedBlocking = checks.filter(isBlocking);

    if (failedBlocking.length > 0) {
      return {
        ok: false,
        code: 'CONFLICT',
        cause: 'precondition',
        reasons: failedBlocking.map((check) => `${check.code}: ${check.message}`),
        failedChecks: failedBlocking,
      };
    }

    const risk = contract.riskRules(params, evidence, ctx);
    if (RISK_ORDER[risk.level] > RISK_ORDER[approvedRisk]) {
      return {
        ok: false,
        code: 'CONFLICT',
        cause: 'risk_escalation',
        reasons: [`risk escalated from ${approvedRisk} to ${risk.level}`, ...risk.reasons],
        failedChecks: [],
      };
    }

    return {
      ok: true,
      params,
      evidence,
      risk: risk.level,
      reasons: risk.reasons,
      effects: contract.effects(params, evidence),
      audit: contract.audit(params, evidence, null),
      evidenceDigest: computeEvidenceDigest(evidence),
    };
  }

  /** 归一化并双向校验：raw → params 要成功，params 也必须仍然符合 inputSchema。 */
  private normalize<P, EV, DB>(contract: Contract<P, EV, DB>, rawInput: unknown): P {
    let params: P;
    try {
      params = contract.normalize(rawInput);
    } catch (error) {
      const issues = extractIssues(error);
      const message =
        issues.length > 0
          ? issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join('; ')
          : (error as Error).message;
      throw new ContractValidationError(message, issues);
    }

    const verified = contract.inputSchema.safeParse(params);
    if (!verified.success) {
      throw new ContractValidationError(
        `contract ${contract.operation}@${contract.version} produced params that violate its own inputSchema`,
        extractIssues(verified.error),
      );
    }
    return params;
  }
}

export const contractEngine = new ContractEngine();

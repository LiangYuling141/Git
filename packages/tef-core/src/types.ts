import type { z } from 'zod';

/**
 * TEF 框架核心的类型定义。
 *
 * 权威来源：docs/technical/14-unified-architecture.md
 *   §3 唯一风险模型 · §5 契约引擎 · §6 工具层与协议 · §8 TaskState · §10 审计
 *
 * 框架核心不得依赖任何垂直字段（§7.1 注）。垂直语义通过泛型参数 P / EV / DB 注入。
 */

/**
 * 垂直注入的事务句柄。框架核心不关心具体数据库类型；
 * Prisma 类型由 tef-mcp-kit 与垂直包在边界处声明。
 */
export type DbTx = unknown;

// -----------------------------------------------------------------------------
// 风险模型（§3）
// -----------------------------------------------------------------------------

export type RiskLevel = 'L0' | 'L1' | 'L2';
/** Block 是结果不是等级，拥有最高优先级，不可被任何因子降级。 */
export type RiskOutcome = RiskLevel | 'Block';

export type OpType = 'query' | 'create' | 'update' | 'delete';
export type CustomerType = 'normal' | 'new' | 'vip' | 'high_risk' | 'restricted';
export type WhitelistLevel = 'none' | 'WL1' | 'WL2' | 'WL3';

/** 租户阈值里由框架读取的键；其余键由垂直契约自行解释。 */
export const AMOUNT_THRESHOLD_KEY = 'amountL2Threshold';

/**
 * 命中即升 L2 的敏感字段（§3.2 第 4 步的 S3/S4）。
 * 白名单只能影响第 3 步的比较基准，不能影响这一项。
 */
export const SENSITIVE_FIELDS: readonly string[] = [
  'creditLimit',
  'credit_limit',
  'creditLine',
  'credit_line',
  'price',
  'cost',
  'discount',
];

export interface RiskInput {
  opType: OpType;
  entity: string;
  fields: string[];
  amount?: number;
  customer: {
    type: CustomerType;
    overdueDays: number;
    creditAvailable: number;
  };
  context: {
    /** 由调用方传入的快照，不是墙上时钟——纯函数与可复现评测的前提（§3.1） */
    timestampSnapshot: Date;
    /** 由调用方传入，不是实时统计 */
    recentOpCount: number;
    whitelistLevel: WhitelistLevel;
    tenantThresholds: Record<string, number>;
  };
}

export interface RiskResult {
  level: RiskOutcome;
  reasons: string[];
}

// -----------------------------------------------------------------------------
// 契约（§5.1）
// -----------------------------------------------------------------------------

export interface Check {
  /** 稳定标识，例如 customer.credit_available_sufficient */
  id: string;
  ok: boolean;
  /** 稳定错误码，例如 INSUFFICIENT_CREDIT */
  code: string;
  /** 面向人的解释，会出现在确认页与审计里 */
  message: string;
  /**
   * 默认 'block'。契约是唯一规则源（公理 I5），所以严重级别由契约声明，
   * 而不是由引擎按 code 猜测。
   */
  severity?: 'block' | 'warn';
}

export interface EffectRef {
  /** 引用前序 effect 通过 `as` 命名的产物 */
  fromRef: string;
  field: string;
}

export interface Effect {
  type: 'create' | 'update' | 'reserve' | 'release';
  entity: string;
  /** 命名这一步的产物，供后续步骤通过 bind 引用 */
  as?: string;
  payload: Record<string, unknown>;
  /** update / reserve / release 的目标主键；create 忽略 */
  target?: string;
  /** 声明式增量，例如 { reservedQty: 5000, availableQty: -5000 } */
  increment?: Record<string, number>;
  /** payload 中需要引用前序产物的字段。显式声明，不做字符串模板解析。 */
  bind?: Record<string, EffectRef>;
}

export interface DiffEntry {
  entity: string;
  action: Effect['type'];
  /** 人类可读的一行摘要，确认页直接展示 */
  label?: string;
  /** 新建实体的载荷 */
  payload?: Record<string, unknown>;
  /** before/after 用于绝对值变化，delta 用于增减量（库存预占、额度占用） */
  changes: Array<{ field: string; before?: unknown; after?: unknown; delta?: number }>;
}

export interface AuditSpec {
  /** 只放假名引用与非标识性字段，绝不放姓名/电话/地址（§10.2） */
  subjectRef?: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** 保留期上限声明，不能覆盖合规下限（§10.3） */
  retainDays?: number;
}

export interface ExecResult {
  ok: boolean;
  /** 各 effect 产物，按 `as` 命名 */
  refs: Record<string, Record<string, unknown>>;
  error?: { code: ErrorCode; message: string };
}

/**
 * 契约执行时可见的上下文。
 *
 * `db` 是垂直注入的数据访问句柄：框架核心不知道它是什么，因此不可能依赖 CRM 字段。
 * 只有 `loadEvidence` 与 EffectExecutor 会用到它；Check 与 riskRules 拿不到 db，
 * 从类型上就无法偷偷做 IO（§5.2 约束 2）。
 */
export interface ExecContext<DB = unknown> {
  tenantId: string;
  userId: string;
  sessionId: string;
  role: TenantRole;
  traceId: string;
  timestampSnapshot: Date;
  recentOpCount: number;
  whitelistLevel: WhitelistLevel;
  tenantThresholds: Record<string, number>;
  db: DB;
  /** 业务数据端口；由 MCP Kit 的运行时通过工厂注入。 */
  gateway?: import('./business-gateway').BusinessGateway;
}

export interface Contract<P = unknown, EV = unknown, DB = unknown> {
  /** 例如 create_order */
  operation: string;
  /** 例如 "1.0"。令牌绑定契约版本，旧版本令牌不可用于新契约（§5.2 约束 5）。 */
  version: string;
  inputSchema: z.ZodType<P>;
  /** 单位 / 币种 / 默认值归一化。intentHash 绑定的是它的输出。 */
  normalize(raw: unknown): P;
  /** 唯一允许 IO 的钩子，且只读（§5.3） */
  loadEvidence(p: P, ctx: ExecContext<DB>): Promise<EV>;
  /** 失败即阻断 */
  preconditions(p: P, ev: EV): Check[];
  /** 执行过程中必须保持 */
  invariants(p: P, ev: EV): Check[];
  permissions(p: P, ctx: ExecContext<DB>): Check[];
  /** 必须是纯函数：不读墙上时钟、不访问数据库、不依赖全局状态（§3.1） */
  riskRules(p: P, ev: EV, ctx: ExecContext<DB>): RiskResult;
  /** 声明式列表，由引擎在事务内统一执行；契约自己不写库（§5.2 约束 3） */
  effects(p: P, ev: EV): Effect[];
  compensation(p: P, ev: EV, r: ExecResult): Effect[];
  /** r 为 null 表示预览阶段，此时只有 before 有意义 */
  audit(p: P, ev: EV, r: ExecResult | null): AuditSpec;
  /** 成功执行时写入的审计结果；补偿契约应声明 'compensated'，缺省为 'success'。 */
  auditResult?: AuditResultType;
  /**
   * 确认页展示的服务端 diff。框架核心不猜字段语义，所以由契约提供；
   * 缺省时引擎从 effects 派生一个粗粒度 diff。
   */
  diff?(p: P, ev: EV): DiffEntry[];
}

// -----------------------------------------------------------------------------
// 租户与角色（§11）
// -----------------------------------------------------------------------------

export type TenantRole = 'owner' | 'sales' | 'finance' | 'viewer';

// -----------------------------------------------------------------------------
// 工具层协议（§6）
// -----------------------------------------------------------------------------

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NEEDS_CONFIRMATION'
  | 'RATE_LIMITED'
  // 执行状态机专用：副作用可能已经发生，调用方必须用同一个幂等键重试或等待对账，
  // 绝不能重新预览/换 key。它们与 INTERNAL 的区别是“可恢复但不可重开新执行”。
  | 'EXECUTION_IN_PROGRESS'
  | 'EXECUTION_UNKNOWN'
  | 'INTERNAL';

export type EnvelopeStatus = 'ok' | 'needs_confirmation' | 'blocked' | 'conflict' | 'error';

export interface ToolError {
  code: ErrorCode;
  message: string;
  /** 失败的 Check，便于确认页与 Agent 解释原因 */
  checks?: Check[];
}

/** §6.2 统一返回信封 */
export interface Envelope<T = Record<string, unknown>> {
  status: EnvelopeStatus;
  data?: T;
  diff?: DiffEntry[];
  evidence?: Record<string, unknown>;
  risk?: RiskOutcome;
  reasons?: string[];
  previewId?: string;
  confirmationToken?: string;
  expiresAt?: string;
  auditId?: string;
  traceId?: string;
  error?: ToolError;
}

// -----------------------------------------------------------------------------
// 审计事件（§10.1）
// -----------------------------------------------------------------------------

export type ActorType = 'human' | 'agent' | 'system';
export type AuditDecision = 'allow' | 'confirm' | 'block' | 'reject';
export type AuditResultType =
  | 'success'
  | 'failure'
  | 'compensated'
  | 'compensation_failed'
  // 预审计：执行意图已提交，副作用与结果审计尚未完成，等待结算或对账。
  | 'pending';

/**
 * 参与哈希的事件本体。prevHash / hash 不在其中——hash = H(prevHash ‖ canonical(event))，
 * 自引用会让哈希无法计算。
 */
export interface AuditEventPayload {
  eventId: string;
  traceId: string;
  tenantId: string;
  seq: number;
  actorId: string;
  actorType: ActorType;
  tool: string;
  contract: string;
  contractVersion: string;
  intentHash: string;
  argsRedacted: Record<string, unknown>;
  evidenceDigest: string;
  risk: RiskOutcome;
  reasons: string[];
  decision: AuditDecision;
  result: AuditResultType;
  subjectRef?: string | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
  ts: string;
}

// -----------------------------------------------------------------------------
// TaskState（§8.1）
// -----------------------------------------------------------------------------

export type TaskStatus =
  | 'idle'
  | 'intent_parsed'
  | 'awaiting_clarification'
  | 'context_loaded'
  | 'preview_ready'
  | 'awaiting_confirmation'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'compensated'
  | 'compensation_failed'
  | 'conflict';

export interface ClarifyCandidate {
  id: string;
  label: string;
  matchReason: string;
}

export interface ClarifyQuestion {
  slot: string;
  reason: 'ambiguous' | 'missing' | 'invalid';
  candidates?: ClarifyCandidate[];
}

export type IntentResult =
  | { kind: 'operation'; contract: string; slots: Record<string, unknown>; unresolved?: string[] }
  // slots 是 §7.3 要求的"intent 快照"：追问时必须连同已解析的槽位一起持久化，
  // 否则用户回答完就得从头再说一遍。
  // contract 记录这次澄清属于哪个操作，回答后才能回到正确契约（如 compensate_order）。
  | { kind: 'clarify'; contract?: string; questions: ClarifyQuestion[]; slots?: Record<string, unknown> }
  | { kind: 'compound'; steps: IntentResult[] }
  | { kind: 'chat'; reply: string };

export interface PendingPreview {
  previewId: string;
  intentHash: string;
  contract: string;
  contractVersion: string;
  expiresAt: Date;
}

export interface TaskState {
  id: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  status: TaskStatus;
  intent?: IntentResult | null;
  pendingPreview?: PendingPreview | null;
  activeCustomerId?: string | null;
  activeOrderId?: string | null;
  idempotencyKey?: string | null;
  /**
   * 未结算执行尝试的显式标记。非空表示副作用可能已经发生：
   * 必须用同一 idempotencyKey 重试或等待对账，不能把它当成新操作。
   * 只在执行结果确定（成功/冲突/确定失败）时清空。
   */
  pendingExecutionAttemptId?: string | null;
  clarificationRounds: number;
  /** 乐观锁 */
  version: number;
  /** 任务级 trace：含澄清往返的整个生命周期共用一条链 */
  traceId?: string | null;
  updatedAt: Date;
}

/** §7.3 澄清轮次上限；超过则终止任务，不再追问。 */
export const MAX_CLARIFICATION_ROUNDS = 3;

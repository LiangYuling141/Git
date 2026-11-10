import { prisma } from '@/lib/prisma';
import { loadTokenSecret, resolveTenantContext } from '@lymtrix/tef-mcp-kit';
import { runAgentTurn, taskStateStore, type TokenUsage } from '@lymtrix/tef-runtime';
import { connectCrmErpClient } from '@lymtrix/vertical-crm-erp';
import { createModelAdapter, type ModelMode } from './model';
import { computeSampleCost } from './pricing';
import { FixtureCrmGateway } from './fixtures';
import type { EvalSample } from './sample';
import type { ActualOutcome, Decision, SampleOutcome } from './outcome';

export interface TurnDecisionInput {
  envelopeStatus?: string;
  taskStatus: string;
  reply?: string;
  hasEnvelope: boolean;
}

/** MCP 工具层拒绝未注册/不可见工具时返回的原始错误文本。 */
const TOOL_NOT_VISIBLE = /Tool [\w.]+ (?:not found|not visible)/;

/**
 * 端到端决策映射：信封状态优先，边界情况再参考回复文本。
 *
 * - `idle` 且无信封：本轮只产生了聊天回复，没有形成可执行操作，用户需要
 *   补充信息；与离线层 chat → clarify 的口径一致。
 * - 回复命中工具可见性错误：MCP server 按 principal 注册工具，viewer 等角色
 *   看不到写工具。这是可信执行边界在协议层已阻止写入，应计为 block，
 *   不是普通执行错误。
 * - 回复表示库存档案缺失/未知商品：业务事实不足，交还用户澄清。
 */
export function decisionForTurn(input: TurnDecisionInput): Decision {
  if (input.taskStatus === 'awaiting_clarification') return 'clarify';
  if (input.taskStatus === 'idle' && !input.hasEnvelope) return 'clarify';
  if (input.envelopeStatus === 'blocked') return 'block';
  if (input.envelopeStatus === 'needs_confirmation') return 'confirm';
  if (input.envelopeStatus === 'ok') return 'allow';
  if (input.reply) {
    if (TOOL_NOT_VISIBLE.test(input.reply)) return 'block';
    if (
      input.reply.includes('库存档案里没有') ||
      input.reply.includes('没有找到商品')
    ) {
      return 'clarify';
    }
  }
  return 'error';
}

const TOOL_CONTRACT: Record<string, string> = {
  'order.preview_create': 'create_order',
  'order.execute_create': 'create_order',
  'order.preview_compensate': 'compensate_order',
  'order.execute_compensate': 'compensate_order',
  'credit.get': 'credit.get',
  'inventory.check': 'inventory.check',
  'customer.search': 'customer.search',
  'order.get': 'order.get',
};

/** block 场景的 TaskState.intent 会被清空，用最后一个工具调用反推契约。 */
function inferContract(toolCalls: Array<{ tool: string }>): string | null {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const mapped = TOOL_CONTRACT[toolCalls[index].tool];
    if (mapped) return mapped;
  }
  return null;
}

/** 每个样本使用独立用户，避免共享用户被 upsert 改写 home tenant 后互相串扰。 */
function evalUserId(sample: EvalSample): string {
  return `u_eval_${sample.id}`;
}

async function ensureEvalTenant(sample: EvalSample): Promise<string> {
  const tenantId = `t_eval_${sample.id}`;
  const userId = evalUserId(sample);
  await prisma.tenant.upsert({
    where: { id: tenantId },
    create: {
      id: tenantId,
      name: `Eval ${sample.id}`,
      slug: `eval-${sample.id}`,
      thresholds: sample.tenant.thresholds,
    },
    update: { thresholds: sample.tenant.thresholds },
  });
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId, userName: `Eval ${sample.id}`, tenantId },
    update: { tenantId },
  });
  await prisma.tenantMember.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: { tenantId, userId, role: sample.principal.role },
    update: { role: sample.principal.role },
  });
  return tenantId;
}

export async function runE2eSample(
  sample: EvalSample,
  modelMode: ModelMode,
  recordedDir?: string,
): Promise<SampleOutcome> {
  const started = performance.now();
  const tenantId = await ensureEvalTenant(sample);
  const userId = evalUserId(sample);
  const resolved = await resolveTenantContext(userId, prisma, tenantId);
  const principal = {
    ...resolved,
    sessionId: `s_eval_${sample.id}`,
    clientKind: 'agent' as const,
  };
  const secret = loadTokenSecret();
  const conversationId = `conv_eval_${sample.id}_${Date.now()}`;
  const baseAdapter = createModelAdapter(sample, modelMode, recordedDir);
  const usages: TokenUsage[] = [];
  const adapter = baseAdapter
    ? {
        ...baseAdapter,
        onUsage: (usage: TokenUsage) => {
          usages.push(usage);
          baseAdapter.onUsage?.(usage);
        },
      }
    : undefined;
  const gateway = new FixtureCrmGateway(sample.fixtures);
  // 评测不执行真实业务 effects：L1 的执行也由这个 no-op 执行器拦截。
  const effectsExecutor = {
    async execute() {
      return { ok: true as const, refs: {} };
    },
  };

  let taskState = await taskStateStore.loadOrCreate(tenantId, conversationId, userId);
  let last: Awaited<ReturnType<typeof runAgentTurn>> | undefined;

  const previousKey = process.env.DEEPSEEK_API_KEY;
  if (modelMode === 'deterministic') process.env.DEEPSEEK_API_KEY = '';
  try {
    for (let index = 0; index < sample.input.messages.length; index += 1) {
      const traceId = `tr_eval_${sample.id}_${Date.now()}_${index}`;
      last = await runAgentTurn({
        message: sample.input.messages[index],
        conversationId,
        principal,
        taskState,
        traceId,
        secret,
        connectSession: async (options) =>
          connectCrmErpClient({
            ...options,
            gateway,
            // 预览/执行路径的业务证据与查询工具必须来自同一份冻结 fixture：
            // 仅传 gateway 只覆盖查询工具，契约预览会回落到 Prisma 网关。
            gatewayFactory: () => gateway,
            effectsExecutor,
          }),
        model: adapter,
      });
      // 非确定性模式必须真实走到模型；静默回落会把 mock/recorded/live 失败标成成功样本。
      if (modelMode !== 'deterministic' && last.intentSource !== 'model') {
        throw new Error(
          `sample ${sample.id}: model mode ${modelMode} fell back to deterministic on turn ${index}`,
        );
      }
      taskState = await taskStateStore.update(
        tenantId,
        conversationId,
        { ...last.patch, traceId },
        taskState.version,
      );
    }
  } finally {
    if (modelMode === 'deterministic') {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  }

  const envelope = last?.envelope;
  const intent = taskState.intent;
  const actual: ActualOutcome = {
    decision: decisionForTurn({
      envelopeStatus: envelope?.status,
      taskStatus: last?.status ?? taskState.status,
      reply: last?.reply,
      hasEnvelope: envelope !== undefined,
    }),
    contract:
      intent?.kind === 'operation'
        ? intent.contract
        : inferContract(last?.toolCalls ?? []),
    slots: intent?.kind === 'operation' ? intent.slots : {},
    risk: envelope?.risk ?? null,
    // 与离线层口径一致：优先记录具体失败检查的稳定错误码，缺省回落信封错误码。
    code: envelope?.error?.checks?.[0]?.code ?? envelope?.error?.code,
    reasons: envelope?.reasons ?? (last?.reply ? [last.reply] : []),
  };

  return {
    sampleId: sample.id,
    category: sample.category,
    expected: sample.expect,
    actual,
    intentSource: last?.intentSource ?? 'none',
    latencyMs: performance.now() - started,
    usage: usages.length > 0 ? usages : undefined,
    // 只有 live 模式的 usage 才对应真实计费；价目缺失时返回 null，不用 0 掩盖。
    cost: computeSampleCost(usages, modelMode),
  };
}

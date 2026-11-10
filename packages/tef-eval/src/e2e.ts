import { prisma } from '@/lib/prisma';
import { loadTokenSecret, resolveTenantContext } from '@lymtrix/tef-mcp-kit';
import { runAgentTurn, taskStateStore, type TokenUsage } from '@lymtrix/tef-runtime';
import { connectCrmErpClient } from '@lymtrix/vertical-crm-erp';
import { createModelAdapter, type ModelMode } from './model';
import { estimateCost } from './pricing';
import { FixtureCrmGateway } from './fixtures';
import type { EvalSample } from './sample';
import type { ActualOutcome, Decision, SampleOutcome } from './outcome';

function decisionForEnvelope(
  status: string | undefined,
  taskStatus: string,
): Decision {
  if (taskStatus === 'awaiting_clarification') return 'clarify';
  if (status === 'blocked') return 'block';
  if (status === 'needs_confirmation') return 'confirm';
  if (status === 'ok') return 'allow';
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

async function ensureEvalTenant(sample: EvalSample): Promise<string> {
  const tenantId = `t_eval_${sample.id}`;
  const userId = sample.principal.userId;
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
  const userId = sample.principal.userId;
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
      taskState = await taskStateStore.update(
        tenantId,
        conversationId,
        { ...last.patch, traceId },
        taskState.version,
      );
    }
  } finally {
    if (modelMode === 'deterministic') process.env.DEEPSEEK_API_KEY = previousKey;
  }

  const envelope = last?.envelope;
  const intent = taskState.intent;
  const actual: ActualOutcome = {
    decision: decisionForEnvelope(envelope?.status, last?.status ?? taskState.status),
    contract:
      intent?.kind === 'operation'
        ? intent.contract
        : inferContract(last?.toolCalls ?? []),
    slots: intent?.kind === 'operation' ? intent.slots : {},
    risk: envelope?.risk ?? null,
    code: envelope?.error?.code,
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
    // 只有 live 模式的 usage 才对应真实计费；mock/recorded 的 0 token 不折算成本。
    cost:
      modelMode === 'live' && usages.length > 0
        ? usages.reduce((sum, usage) => sum + (estimateCost(usage) ?? 0), 0)
        : null,
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canCallTool, toolsForClient } from '@/tef/tenant';
import { loadTokenSecret } from '@/tef/token';
import { envelopeToToolResult, fail } from './envelope';
import type { Principal } from './principal';
import { auditTrace, policyGet } from './tools/audit';
import { confirmationApprove, confirmationReject } from './tools/confirmation';
import {
  orderExecuteCompensate,
  orderExecuteCreate,
  orderPreviewCompensate,
  orderPreviewCreate,
} from './tools/order';
import { creditGet, customerGet, customerSearch, inventoryCheck, orderGet } from './tools/query';

/**
 * MCP Server（L4 工具层）。
 *
 * §6.4：治理工具按 client 身份注册，而不是靠文档约定。
 * Agent Runtime 拿到的 server 里根本没有 confirmation.approve 这个工具——
 * 模型不是"被叮嘱不要自己确认"，而是物理上调用不到。
 *
 * traceId 在构造时固定，不接受模型传入：审计链的分组不能被被审计方影响。
 */

export interface TefServerOptions {
  principal: Principal;
  traceId: string;
  secret?: string;
}

const ORDER_ITEM_SHAPE = {
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  // 单价必须由调用方给出并会被契约与商品档案核对；
  // 模型不知道价格时应当先调 inventory.check，而不是猜。
  unitPrice: z.number().nonnegative(),
};

export function createTefServer(options: TefServerOptions): McpServer {
  const { principal, traceId } = options;
  const secret = options.secret ?? loadTokenSecret();
  const writeOptions = { traceId, secret };
  const queryOptions = { traceId };

  const server = new McpServer({ name: 'lymatrix-tef', version: '0.1.0' });
  const visible = new Set(toolsForClient(principal.clientKind).filter((tool) => canCallTool(principal.role, tool)));
  const register = (tool: string): boolean => visible.has(tool);

  if (register('customer.search')) {
    server.registerTool(
      'customer.search',
      {
        title: '搜索客户',
        description:
          'Search customers in the current tenant by name or phone. Returns a candidate list with matchReason. ' +
          'When more than one candidate matches, ask the user to disambiguate before proposing any write.',
        inputSchema: {
          name: z.string().optional(),
          phone: z.string().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await customerSearch(principal, args, queryOptions)),
    );
  }

  if (register('customer.get')) {
    server.registerTool(
      'customer.get',
      {
        title: '读取客户快照',
        description: 'Read one customer snapshot by id, scoped to the current tenant.',
        inputSchema: { customerId: z.string().min(1) },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await customerGet(principal, args, queryOptions)),
    );
  }

  if (register('credit.get')) {
    server.registerTool(
      'credit.get',
      {
        title: '查询信用额度',
        description:
          'Read credit limit, used credit, available credit, overdue days and open order balances for one customer.',
        inputSchema: { customerId: z.string().min(1) },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await creditGet(principal, args, queryOptions)),
    );
  }

  if (register('inventory.check')) {
    server.registerTool(
      'inventory.check',
      {
        title: '查询库存与报价',
        description:
          'Check available and reserved inventory for a SKU, together with the master unit price. ' +
          'Use the returned unitPrice when proposing an order; a price that differs from the master data will be blocked.',
        inputSchema: { sku: z.string().optional(), quantity: z.number().int().positive().optional() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await inventoryCheck(principal, args, queryOptions)),
    );
  }

  if (register('order.get')) {
    server.registerTool(
      'order.get',
      {
        title: '读取订单',
        description: 'Read one order with its payment plan by orderId or orderNo.',
        inputSchema: { orderId: z.string().optional(), orderNo: z.string().optional() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await orderGet(principal, args, queryOptions)),
    );
  }

  if (register('order.preview_create')) {
    server.registerTool(
      'order.preview_create',
      {
        title: '预览赊账订单',
        description:
          'Validate and preview an order creation. Returns diff, risk, reasons, preview_id and a one-time ' +
          'confirmation_token. Does not write business data. For risk L2 the token only becomes usable after a ' +
          'human approves it through a separate client; this tool cannot approve it.',
        inputSchema: {
          customerId: z.string().min(1),
          items: z.array(z.object(ORDER_ITEM_SHAPE)).min(1),
          discount: z.number().nonnegative().optional(),
          depositRate: z.number().min(0).max(1).optional(),
          termsDays: z.number().int().min(0).optional(),
          remark: z.string().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await orderPreviewCreate(principal, args, writeOptions)),
    );
  }

  if (register('order.execute_create')) {
    server.registerTool(
      'order.execute_create',
      {
        title: '执行赊账订单',
        description:
          'Execute the previewed order. Accepts ONLY confirmation_token and idempotency_key. ' +
          'Business parameters are read from the server-side preview snapshot; parameters supplied here are ignored. ' +
          'Reusing a token returns CONFLICT.',
        inputSchema: {
          confirmation_token: z.string().min(1),
          idempotency_key: z.string().min(1),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        envelopeToToolResult(
          await orderExecuteCreate(
            principal,
            { confirmation_token: args.confirmation_token, idempotency_key: args.idempotency_key },
            writeOptions,
          ),
        ),
    );
  }

  if (register('order.preview_compensate')) {
    server.registerTool(
      'order.preview_compensate',
      {
        title: '预览订单补偿',
        description:
          'Validate and preview compensation of a committed order. Returns diff, risk, reasons, preview_id and a ' +
          'one-time confirmation_token. Compensation is always L2 and requires human approval through a separate ' +
          'client. Only orders created through TEF with a preview snapshot can be compensated.',
        inputSchema: {
          orderId: z.string().min(1),
          reason: z.string().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await orderPreviewCompensate(principal, args, writeOptions)),
    );
  }

  if (register('order.execute_compensate')) {
    server.registerTool(
      'order.execute_compensate',
      {
        title: '执行订单补偿',
        description:
          'Execute a previewed order compensation. Accepts ONLY confirmation_token and idempotency_key. ' +
          'Business parameters are read from the server-side preview snapshot; parameters supplied here are ignored. ' +
          'Reusing a token returns CONFLICT.',
        inputSchema: {
          confirmation_token: z.string().min(1),
          idempotency_key: z.string().min(1),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        envelopeToToolResult(
          await orderExecuteCompensate(
            principal,
            { confirmation_token: args.confirmation_token, idempotency_key: args.idempotency_key },
            writeOptions,
          ),
        ),
    );
  }

  if (register('confirmation.approve')) {
    server.registerTool(
      'confirmation.approve',
      {
        title: '人工批准',
        description:
          'Human approval of an L2 confirmation token. Returns the server-side diff and evidence so the approver ' +
          'sees exactly what was proposed. Not visible to the agent runtime.',
        inputSchema: { confirmation_token: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) =>
        envelopeToToolResult(await confirmationApprove(principal, { confirmation_token: args.confirmation_token }, writeOptions)),
    );
  }

  if (register('confirmation.reject')) {
    server.registerTool(
      'confirmation.reject',
      {
        title: '人工拒绝',
        description: 'Human rejection of a confirmation token. Revokes the underlying preview snapshot.',
        inputSchema: { confirmation_token: z.string().min(1), reason: z.string().max(500).optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) =>
        envelopeToToolResult(
          await confirmationReject(
            principal,
            { confirmation_token: args.confirmation_token, reason: args.reason },
            writeOptions,
          ),
        ),
    );
  }

  if (register('audit.trace')) {
    server.registerTool(
      'audit.trace',
      {
        title: '回放决策链',
        description:
          'Replay the full decision chain for a trace, together with the hash-chain verification result for this tenant.',
        inputSchema: { traceId: z.string().optional() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => envelopeToToolResult(await auditTrace(principal, { traceId: args.traceId ?? traceId })),
    );
  }

  if (register('policy.get')) {
    server.registerTool(
      'policy.get',
      {
        title: '读取策略',
        description: 'Read tenant thresholds, the caller role, and the tool scope visible to this client.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => envelopeToToolResult(await policyGet(principal)),
    );
  }

  return server;
}

/** 供人工确认 UI 直接调用治理工具，不必经过 MCP 传输。 */
export async function approveOutOfBand(
  principal: Principal,
  token: string,
  traceId: string,
  secret = loadTokenSecret(),
) {
  if (!canCallTool(principal.role, 'confirmation.approve') || !toolsForClient(principal.clientKind).includes('confirmation.approve')) {
    return fail('PERMISSION_DENIED', `client kind ${principal.clientKind} cannot approve confirmations`);
  }
  return confirmationApprove(principal, { confirmation_token: token }, { traceId, secret });
}

export { visibleToolsFor };

function visibleToolsFor(principal: Principal): string[] {
  return toolsForClient(principal.clientKind).filter((tool) => canCallTool(principal.role, tool));
}

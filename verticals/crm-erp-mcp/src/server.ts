import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  connectTefClient,
  createTefServer,
  envelopeToToolResult,
  type TefClientSession,
  type TefServerOptions,
  type VerticalToolContext,
} from '@lymtrix/tef-mcp-kit';
import {
  orderExecuteCompensate,
  orderExecuteCreate,
  orderPreviewCompensate,
  orderPreviewCreate,
} from './tools/order';
import { creditGet, customerGet, customerSearch, inventoryCheck, orderGet } from './tools/query';

/**
 * CRM-ERP 垂直 MCP Server（L4 工具层）。
 *
 * 通用治理工具（确认、审计、策略）由 @lymtrix/tef-mcp-kit 的 createTefServer 注册；
 * 这里只注册义乌赊账订单垂直暴露给模型的查询与写入工具。
 */

const ORDER_ITEM_SHAPE = {
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  // 单价必须由调用方给出并会被契约与商品档案核对；
  // 模型不知道价格时应当先调 inventory.check，而不是猜。
  unitPrice: z.number().nonnegative(),
};

function registerCrmErpTools({ server, principal, register, writeOptions, queryOptions }: VerticalToolContext): void {
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
}

export function createCrmErpServer(options: TefServerOptions): McpServer {
  return createTefServer(options, registerCrmErpTools);
}

export function connectCrmErpClient(options: TefServerOptions): Promise<TefClientSession> {
  return connectTefClient(options, createCrmErpServer);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canCallTool, toolsForClient } from './tenant';
import { loadTokenSecret } from './token';
import { envelopeToToolResult, fail } from './envelope';
import type { Principal } from './principal';
import { auditTrace, policyGet } from './tools/audit';
import { confirmationApprove, confirmationReject } from './tools/confirmation';
import type { ContractWriteOptions } from './tools/contract';

export interface TefServerOptions {
  principal: Principal;
  traceId: string;
  secret?: string;
}

export interface VerticalToolContext {
  server: McpServer;
  principal: Principal;
  traceId: string;
  register: (tool: string) => boolean;
  writeOptions: ContractWriteOptions;
  queryOptions: { traceId: string };
}

export type VerticalToolRegistrar = (context: VerticalToolContext) => void;

export function createTefServer(
  options: TefServerOptions,
  registerVertical?: VerticalToolRegistrar,
): McpServer {
  const { principal, traceId } = options;
  const secret = options.secret ?? loadTokenSecret();
  const writeOptions = { traceId, secret };
  const queryOptions = { traceId };

  const server = new McpServer({ name: 'lymtrix-tef', version: '0.1.0' });
  const visible = new Set(toolsForClient(principal.clientKind).filter((tool) => canCallTool(principal.role, tool)));
  const register = (tool: string): boolean => visible.has(tool);

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

  registerVertical?.({ server, principal, traceId, register, writeOptions, queryOptions });
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

export function visibleToolsFor(principal: Principal): string[] {
  return toolsForClient(principal.clientKind).filter((tool) => canCallTool(principal.role, tool));
}

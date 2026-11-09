import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Envelope } from '@lymatrix/tef-core';
import type { TefServerOptions } from './server';

/**
 * Agent Runtime 与 MCP Server 之间的进程内传输。
 *
 * 用真实的 MCP 协议栈而不是直接函数调用，是为了让信任边界物理存在：
 * Runtime 手里只有一个 Client，拿不到 Prisma、拿不到 BusinessEngine、
 * 也看不到 confirmation.approve（公理 I2、§6.4）。
 *
 * 人工确认 UI 会建立一个 clientKind 不同的独立会话，因此看到的是另一套工具集。
 *
 * `createServer` 必须由调用方显式注入：kit 不反向依赖任何垂直包。
 */

export type TefServerFactory = (options: TefServerOptions) => McpServer;

export interface TefClientSession {
  client: Client;
  /** 这个 client 实际能看到的工具名——由服务端注册决定，不是文档约定 */
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<Envelope>;
  close(): Promise<void>;
}

export async function connectTefClient(
  options: TefServerOptions,
  createServer: TefServerFactory,
): Promise<TefClientSession> {
  const server = createServer(options);
  const client = new Client({ name: `tef-${options.principal.clientKind}`, version: '0.1.0' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((tool) => tool.name);
    },
    async callTool(name, args) {
      let result;
      try {
        result = await client.callTool({ name, arguments: args });
      } catch (error) {
        // 工具未注册、协议错误等。保留原始信息，否则 Agent 无从判断该怎么恢复。
        return {
          status: 'error' as const,
          error: { code: 'INTERNAL' as const, message: error instanceof Error ? error.message : String(error) },
        };
      }

      const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find(
        (part) => part.type === 'text',
      )?.text;

      if (result.isError && !result.structuredContent) {
        return {
          status: 'error' as const,
          error: { code: 'INTERNAL' as const, message: text ?? `tool ${name} returned an error` },
        };
      }

      if (result.structuredContent) {
        return result.structuredContent as unknown as Envelope;
      }
      // 没有结构化内容时从文本回退解析，保证调用方永远拿到信封形状
      if (!text) return { status: 'error', error: { code: 'INTERNAL', message: `tool ${name} returned no content` } };
      try {
        return JSON.parse(text) as Envelope;
      } catch {
        return { status: 'error', error: { code: 'INTERNAL', message: `tool ${name} returned unparseable content` } };
      }
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

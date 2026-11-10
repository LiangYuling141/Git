import { describe, expect, it } from 'vitest';
import { createCrmErpServer } from './server';

describe('CRM MCP server options', () => {
  it('accepts an injected gateway and gatewayFactory without touching the database', () => {
    const server = createCrmErpServer({
      principal: {
        tenantId: 't_eval',
        userId: 'u_eval',
        sessionId: 's_eval',
        role: 'owner',
        clientKind: 'agent',
      },
      traceId: 'tr_eval',
      secret: 'test-secret-that-is-long-enough-to-be-accepted',
      gateway: {
        query: async <T>() => ({}) as T,
        executeEffects: async () => ({ ok: true, refs: {} }),
        searchCustomers: async () => [],
        getCustomer: async () => null,
        getCredit: async () => null,
        getProducts: async () => [],
        searchProducts: async () => [],
        getOrder: async () => null,
      },
      gatewayFactory: () => {
        throw new Error('factory must not be called during server construction');
      },
      effectsExecutor: {
        execute: async () => ({ ok: true, refs: {} }),
      },
    });

    expect(server).toBeDefined();
  });
});

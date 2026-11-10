import { fileURLToPath } from 'node:url';

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default {
  resolve: {
    alias: [
      { find: /^@lymtrix\/tef-core\/(.*)$/, replacement: `${r('./packages/tef-core/src')}/$1` },
      { find: '@lymtrix/tef-core', replacement: r('./packages/tef-core/src/index.ts') },
      { find: /^@lymtrix\/tef-mcp-kit\/(.*)$/, replacement: `${r('./packages/tef-mcp-kit/src')}/$1` },
      { find: '@lymtrix/tef-mcp-kit', replacement: r('./packages/tef-mcp-kit/src/index.ts') },
      { find: /^@lymtrix\/tef-runtime\/(.*)$/, replacement: `${r('./packages/tef-runtime/src')}/$1` },
      { find: '@lymtrix/tef-runtime', replacement: r('./packages/tef-runtime/src/index.ts') },
      { find: /^@lymtrix\/vertical-crm-erp\/(.*)$/, replacement: `${r('./verticals/crm-erp-mcp/src')}/$1` },
      { find: '@lymtrix/vertical-crm-erp', replacement: r('./verticals/crm-erp-mcp/src/index.ts') },
      { find: /^@lymtrix\/tef-eval\/(.*)$/, replacement: `${r('./packages/tef-eval/src')}/$1` },
      { find: '@lymtrix/tef-eval', replacement: r('./packages/tef-eval/src/index.ts') },
      { find: '@', replacement: r('./src') },
    ],
  },
};

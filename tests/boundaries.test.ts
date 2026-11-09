import { describe, expect, it } from 'vitest';
import { checkSource } from '../scripts/check-boundaries.mjs';

describe('package boundary checker', () => {
  it('rejects filesystem imports from tef-core', () => {
    const violations = checkSource(
      'packages/tef-core/src/probe.ts',
      "import fs from 'node:fs';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/tef-core/src/probe.ts',
      specifier: 'node:fs',
      rule: 'forbidden-import',
    });
  });

  it('rejects relative imports that escape the package root', () => {
    const violations = checkSource(
      'packages/tef-core/src/probe.ts',
      "import { prisma } from '../../../src/lib/prisma';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/tef-core/src/probe.ts',
      specifier: '../../../src/lib/prisma',
      rule: 'relative-escape',
    });
  });

  it('rejects token-store imports from the runtime', () => {
    const violations = checkSource(
      'packages/tef-runtime/src/probe.ts',
      "import { tokenStore } from '@lymtrix/tef-mcp-kit/token';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      specifier: '@lymtrix/tef-mcp-kit/token',
      rule: 'forbidden-import',
    });
  });

  it('rejects runtime imports from the MCP kit package', () => {
    const violations = checkSource(
      'packages/tef-mcp-kit/src/probe.ts',
      "import '@lymtrix/tef-runtime';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      specifier: '@lymtrix/tef-runtime',
      rule: 'forbidden-import',
    });
  });

  it('rejects runtime imports from the CRM vertical', () => {
    const violations = checkSource(
      'verticals/crm-erp-mcp/src/probe.ts',
      "import { createTefRuntime } from '@lymtrix/tef-runtime';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      specifier: '@lymtrix/tef-runtime',
      rule: 'forbidden-import',
    });
  });

  it('rejects static vertical imports from tef-core', () => {
    const violations = checkSource(
      'packages/tef-core/src/probe.ts',
      "import x from '@lymtrix/vertical-crm-erp';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/tef-core/src/probe.ts',
      specifier: '@lymtrix/vertical-crm-erp',
      rule: 'forbidden-import',
    });
  });

  it('rejects dynamic vertical imports from the MCP kit', () => {
    const violations = checkSource(
      'packages/tef-mcp-kit/src/probe.ts',
      "const mod = await import('@lymtrix/vertical-crm-erp');",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/tef-mcp-kit/src/probe.ts',
      specifier: '@lymtrix/vertical-crm-erp',
      rule: 'forbidden-import',
    });
  });

  it('rejects vertical subpath imports from the runtime', () => {
    const violations = checkSource(
      'packages/tef-runtime/src/probe.ts',
      "import { server } from '@lymtrix/vertical-crm-erp/server';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/tef-runtime/src/probe.ts',
      specifier: '@lymtrix/vertical-crm-erp/server',
      rule: 'forbidden-import',
    });
  });

  it('accepts clean tef-core sources', () => {
    const violations = checkSource(
      'packages/tef-core/src/probe.ts',
      [
        "import { createHash } from 'node:crypto';",
        "import { z } from 'zod';",
        "import { classifyRisk } from './risk';",
        "import type { Contract } from '@lymtrix/tef-core';",
      ].join('\n'),
    );

    expect(violations).toEqual([]);
  });
});

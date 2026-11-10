import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSamplesForCli, type SampleLoadResult } from './load';

/** 断言加载失败并返回错误消息；用显式分支保证 TypeScript 收窄联合类型。 */
function failureMessage(result: SampleLoadResult): string {
  if (result.kind === 'ok') throw new Error('expected load failure');
  return result.message;
}

function sample(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category: 'normal',
    tenant: { thresholds: { amountL2Threshold: 5000 } },
    principal: { userId: 'u_eval', role: 'owner' },
    input: { messages: ['伟业公司的信用额度是多少'] },
    fixtures: { customers: [], products: [], orders: [] },
    expect: { decision: 'allow' },
    tags: ['normal'],
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tef-eval-load-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadSamplesForCli', () => {
  it('accepts single objects and arrays, sorted by sample id', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(sample('b_sample')));
    writeFileSync(
      join(dir, 'b.json'),
      JSON.stringify([sample('a_sample'), sample('c_sample')]),
    );

    const result = loadSamplesForCli(dir);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.samples.map((item) => item.id)).toEqual([
        'a_sample',
        'b_sample',
        'c_sample',
      ]);
    }
  });

  it('maps malformed JSON to a load failure', () => {
    writeFileSync(join(dir, 'broken.json'), '{ not json');

    const result = loadSamplesForCli(dir);

    expect(result.kind).toBe('error');
    expect(failureMessage(result)).toContain(`failed to load samples from ${dir}`);
  });

  it('maps zod validation failures to a load failure', () => {
    writeFileSync(
      join(dir, 'invalid.json'),
      JSON.stringify(sample('bad_category', { category: 'not-a-category' })),
    );

    const result = loadSamplesForCli(dir);

    expect(result.kind).toBe('error');
    expect(failureMessage(result)).toContain(`failed to load samples from ${dir}`);
  });

  it('maps duplicate sample ids to a load failure', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(sample('dup')));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(sample('dup')));

    const result = loadSamplesForCli(dir);

    expect(result.kind).toBe('error');
    expect(failureMessage(result)).toContain('duplicate sample id: dup');
  });

  it('maps an empty directory to a load failure', () => {
    const result = loadSamplesForCli(dir);

    expect(result.kind).toBe('error');
    expect(failureMessage(result)).toBe(`no samples found in ${dir}`);
  });

  it('maps an unreadable directory to a load failure', () => {
    const missing = join(dir, 'does-not-exist');

    const result = loadSamplesForCli(missing);

    expect(result.kind).toBe('error');
    expect(failureMessage(result)).toContain(`failed to load samples from ${missing}`);
  });
});

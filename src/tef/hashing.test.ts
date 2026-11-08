import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  canonicalHash,
  computeAuditPayloadDigest,
  computeChainHash,
  computeEvidenceDigest,
  computeIntentHash,
  hashToken,
  hmacSign,
  hmacVerify,
  sha256Hex,
} from './hashing';

const ARGS = {
  customerId: 'c_weiye_import',
  items: [{ sku: 'XMAS-BALL-01', quantity: 5000, unitPrice: 2 }],
  depositRate: 0.3,
  termsDays: 30,
  totalAmount: 10000,
  deposit: 3000,
  balance: 7000,
};

const BASE = { contract: 'create_order', contractVersion: '1.0', normalizedArgs: ARGS };

describe('computeIntentHash', () => {
  it('对同一份归一化参数是确定的', () => {
    expect(computeIntentHash(BASE)).toBe(computeIntentHash(BASE));
    expect(computeIntentHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('与参数字段的书写顺序无关', () => {
    const reordered = {
      ...BASE,
      normalizedArgs: {
        termsDays: 30,
        depositRate: 0.3,
        balance: 7000,
        deposit: 3000,
        totalAmount: 10000,
        items: [{ unitPrice: 2, sku: 'XMAS-BALL-01', quantity: 5000 }],
        customerId: 'c_weiye_import',
      },
    };
    expect(computeIntentHash(reordered)).toBe(computeIntentHash(BASE));
  });

  it('参数被改动就会变化——这是"确认后篡改金额"被拒的依据', () => {
    const tampered = {
      ...BASE,
      normalizedArgs: { ...ARGS, totalAmount: 99999, balance: 96999 },
    };
    expect(computeIntentHash(tampered)).not.toBe(computeIntentHash(BASE));
  });

  it('契约版本变化就会变化——旧版本令牌不能用于新契约', () => {
    expect(computeIntentHash({ ...BASE, contractVersion: '1.1' })).not.toBe(computeIntentHash(BASE));
  });

  it('契约名变化就会变化', () => {
    expect(computeIntentHash({ ...BASE, contract: 'record_payment' })).not.toBe(computeIntentHash(BASE));
  });
});

describe('双层哈希分离（§4.2）', () => {
  it('证据变动不影响 intentHash：否则并发场景下人工确认必然失败', () => {
    const evidenceBefore = { creditAvailable: 10000, inventoryAvailable: 20000 };
    const evidenceAfter = { creditAvailable: 3000, inventoryAvailable: 4800 };

    expect(computeEvidenceDigest(evidenceBefore)).not.toBe(computeEvidenceDigest(evidenceAfter));
    // 两次预览之间同事又下了一单，证据变了，但人批准的那份参数没变：
    expect(computeIntentHash(BASE)).toBe(computeIntentHash(BASE));
  });

  it('同一份内容在不同用途下得到不同哈希（域分隔）', () => {
    const payload = { a: 1 };
    const digests = new Set([
      computeIntentHash({ contract: 'x', contractVersion: '1', normalizedArgs: payload }),
      computeEvidenceDigest(payload),
      computeAuditPayloadDigest(payload),
      canonicalHash(payload),
      hashToken(JSON.stringify(payload)),
    ]);
    expect(digests.size).toBe(5);
  });
});

describe('审计哈希链', () => {
  const event = { eventId: 'aud_1', tenantId: 't_yiwu_demo', seq: 1, tool: 'order.execute_create' };

  it('链接 prevHash：改动前序哈希会改变本条哈希', () => {
    expect(computeChainHash(GENESIS_HASH, event)).not.toBe(computeChainHash('f'.repeat(64), event));
  });

  it('事件内容被篡改会改变哈希', () => {
    expect(computeChainHash(GENESIS_HASH, event)).not.toBe(
      computeChainHash(GENESIS_HASH, { ...event, tool: 'order.execute_delete' }),
    );
  });

  it('同一 prevHash + 同一事件 → 同一哈希（可离线重算校验）', () => {
    expect(computeChainHash(GENESIS_HASH, event)).toBe(computeChainHash(GENESIS_HASH, event));
  });

  it('GENESIS_HASH 是 64 个 0', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });
});

describe('hmac', () => {
  const secret = 'test-secret-key';

  it('正确密钥与内容可通过校验', () => {
    const sig = hmacSign(secret, 'payload');
    expect(hmacVerify(secret, 'payload', sig)).toBe(true);
  });

  it('内容被篡改则校验失败', () => {
    const sig = hmacSign(secret, 'payload');
    expect(hmacVerify(secret, 'payload-tampered', sig)).toBe(false);
  });

  it('密钥不对则校验失败', () => {
    const sig = hmacSign(secret, 'payload');
    expect(hmacVerify('another-secret', 'payload', sig)).toBe(false);
  });

  it('签名长度不同时不抛错，直接判否', () => {
    expect(hmacVerify(secret, 'payload', 'short')).toBe(false);
    expect(hmacVerify(secret, 'payload', '')).toBe(false);
  });

  it('签名是 base64url，不含需要转义的字符', () => {
    expect(hmacSign(secret, 'x')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('sha256Hex', () => {
  it('产出 64 位十六进制', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

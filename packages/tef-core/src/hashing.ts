import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalize } from './canonical';

/**
 * 双层哈希与审计链哈希（docs/technical/14-unified-architecture.md §4.2、§10.1）。
 *
 * 每个用途都有独立的域分隔前缀。没有它，同一份内容被当作 intentHash 与 evidenceDigest
 * 时会得到相同的值，跨用途的哈希就能互相冒充。
 */

// 品牌更名为 LyMtrix，但哈希域必须保持稳定：
// 改动 DOMAIN 会让历史审计链、已签发令牌与预览快照全部失效。
// 如确需更换域，必须发布链迁移方案，而不是跟随品牌改名。
const DOMAIN = 'lymatrix-tef';
const VERSION = 'v1';

const DOMAIN_INTENT = `${DOMAIN}/intent-hash/${VERSION}`;
const DOMAIN_EVIDENCE = `${DOMAIN}/evidence-digest/${VERSION}`;
const DOMAIN_AUDIT_PAYLOAD = `${DOMAIN}/audit-payload/${VERSION}`;
const DOMAIN_AUDIT_CHAIN = `${DOMAIN}/audit-chain/${VERSION}`;
const DOMAIN_TOKEN = `${DOMAIN}/token-hash/${VERSION}`;

/** 每条租户链的第一个 prevHash。 */
export const GENESIS_HASH = '0'.repeat(64);

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function domainHash(domain: string, body: string): string {
  return sha256Hex(`${domain}|${body}`);
}

/** 任意可哈希内容的确定性摘要。 */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export interface IntentHashInput {
  contract: string;
  contractVersion: string;
  /** 必须是 normalize() 之后的参数：intentHash 绑定的是"人批准的那个东西"。 */
  normalizedArgs: unknown;
}

/**
 * intentHash = H(契约名 + 契约版本 + 归一化参数)。
 *
 * 证据绝不进入这里（§4.2）：否则预览与执行之间任何并发变动都会让令牌失效，
 * 人工确认在繁忙场景下必然失败。
 */
export function computeIntentHash(input: IntentHashInput): string {
  return domainHash(
    DOMAIN_INTENT,
    canonicalize({
      contract: input.contract,
      contractVersion: input.contractVersion,
      args: input.normalizedArgs,
    }),
  );
}

/** evidenceDigest = H(预览时载入的证据)。只进审计，用于事后还原"当时看到了什么"。 */
export function computeEvidenceDigest(evidence: unknown): string {
  return domainHash(DOMAIN_EVIDENCE, canonicalize(evidence));
}

/**
 * 审计事件的载荷摘要：对事件本体（不含 prevHash / hash）做 canonical 后取哈希。
 * 校验时用它确认库里的 JSON 仍然是当初被链进去的那份内容。
 */
export function computeAuditPayloadDigest(event: unknown): string {
  return domainHash(DOMAIN_AUDIT_PAYLOAD, canonicalize(event));
}

/** hash = H(prevHash ‖ canonical(event))，事件本体不含 prevHash / hash 自身。 */
export function computeChainHash(prevHash: string, event: unknown): string {
  return domainHash(DOMAIN_AUDIT_CHAIN, `${prevHash}|${canonicalize(event)}`);
}

/** 令牌原文不落库，只存这个摘要；配合唯一约束实现一次性消费。 */
export function hashToken(token: string): string {
  return domainHash(DOMAIN_TOKEN, token);
}

export function hmacSign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

export function hmacVerify(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(hmacSign(secret, body), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  // 长度不同时 timingSafeEqual 会抛错，先比长度再恒定时间比较。
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

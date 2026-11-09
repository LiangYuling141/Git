/**
 * 审计脱敏（§10.2）。
 *
 * 哈希链要求不可变，PIPL 要求个人信息可删除。两者能同时成立的唯一方式是：
 * 审计事件里根本不存直接标识，只存假名引用（subjectRef），
 * 假名与真实标识的映射单独加密存放、可被销毁（crypto-shredding）。
 *
 * 所以这里的策略是"默认拒绝"：命中敏感键名就整体替换，而不是试图局部打码。
 */

const REDACTED = '[redacted]';

/**
 * 键名匹配用"归一化后的后缀 / 子串"，而不是精确相等。
 * 精确名单挡不住 contactPhone、buyerEmail、shipAddress 这类复合命名，
 * 而漏掉一个电话号的代价远大于多脱敏一个字段。
 */
const DENY_SUFFIXES = [
  'name',
  'phone',
  'mobile',
  'email',
  'address',
  'taxid',
  'idcard',
  'idnumber',
  'bankcard',
  'bankaccount',
  'accountnumber',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'contact',
  'person',
];

/** 出现在键名任何位置都要脱敏的高危片段。 */
const DENY_SUBSTRINGS = [
  'idcard',
  'bankcard',
  'creditcard',
  'password',
  'apikey',
  'authorization',
  'socialsecurity',
  'email',
  'taxid',
  'phone',
  'mobile',
  'address',
];

/**
 * 'name' 后缀的例外：这些是商品/技术对象的名称，不是个人信息。
 * 例外清单要短——它是这套默认拒绝策略上唯一的开口。
 */
const NAME_ALLOWLIST = new Set([
  'productname',
  'skuname',
  'itemname',
  'filename',
  'tenantname',
  'toolname',
  'contractname',
  'hostname',
  'rulename',
  'pluginname',
]);

const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 12;

function normalizeKey(key: string): string {
  return key.replace(/[_\-\s]/g, '').toLowerCase();
}

function isDenied(key: string): boolean {
  const normalized = normalizeKey(key);
  if (NAME_ALLOWLIST.has(normalized)) return false;
  if (DENY_SUBSTRINGS.some((fragment) => normalized.includes(fragment))) return true;
  return DENY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** 保留假名引用：以这些前缀开头的值是代理键，不是直接标识。 */
const PSEUDONYM_PREFIXES = ['cust:', 'order:', 'acct:', 'user:'];

export function isPseudonym(value: string): boolean {
  return PSEUDONYM_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function redactString(value: string): string {
  if (isPseudonym(value)) return value;
  if (value.length > MAX_STRING_LENGTH) return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  return value;
}

function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';
  if (value === null || value === undefined) return value ?? null;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isDenied(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }

  return REDACTED;
}

/** 递归脱敏工具参数，用于写入 AuditEvent.argsRedacted。 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redact(args, 0) as Record<string, unknown>;
}

/** 把实体主键转成假名引用。审计里只允许出现这种形式。 */
export function pseudonymize(kind: 'cust' | 'order' | 'acct' | 'user', id: string): string {
  return `${kind}:${id}`;
}

export const REDACTED_PLACEHOLDER = REDACTED;

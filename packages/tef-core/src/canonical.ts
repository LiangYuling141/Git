/**
 * Canonical serialization.
 *
 * `intentHash` 与审计哈希链都建立在这个函数之上：同样的语义内容必须产生同样的字节串，
 * 否则令牌校验与链校验都会出现无法解释的失败。因此这里刻意比 JSON.stringify 更严格——
 * 遇到无法确定性序列化的输入直接抛错，而不是悄悄产生一个歧义结果。
 */

const MAX_DEPTH = 64;

export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeString(value: string): string {
  return JSON.stringify(value);
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`non-finite number ${String(value)} cannot be hashed`, path);
  }
  // JS 的 number→string 是最短可往返表示，本身已确定；JSON.stringify 顺带把 -0 归一为 "0"。
  return JSON.stringify(value);
}

function serialize(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError('maximum nesting depth exceeded', path);
  }

  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return serializeString(value);
    case 'number':
      return serializeNumber(value, path);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      throw new CanonicalizationError('undefined is not hashable; omit the key instead', path);
    case 'bigint':
    case 'symbol':
    case 'function':
      throw new CanonicalizationError(`${typeof value} is not hashable`, path);
    default:
      break;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalizationError('Invalid Date is not hashable', path);
    }
    return serializeString(value.toISOString());
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => serialize(item, `${path}[${index}]`, depth + 1));
    return `[${items.join(',')}]`;
  }

  if (!isPlainObject(value as object)) {
    throw new CanonicalizationError(
      `only plain objects, arrays, Dates and primitives are hashable, got ${
        (value as object).constructor?.name ?? 'unknown'
      }`,
      path,
    );
  }

  const record = value as Record<string, unknown>;
  // 键序必须与插入顺序无关，否则同一份参数会因为字段顺序不同而得到不同 intentHash。
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = record[key];
    // 对象里的 undefined 等价于"该字段不存在"，直接省略；这与 JSON 语义一致。
    if (child === undefined) continue;
    parts.push(`${serializeString(key)}:${serialize(child, path ? `${path}.${key}` : key, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/** 把任意可哈希内容序列化为确定性的紧凑字符串。 */
export function canonicalize(value: unknown): string {
  return serialize(value, '', 0);
}

#!/usr/bin/env node
/**
 * 轻量密钥扫描。
 *
 * 目标不是替代 GitHub secret scanning，而是把两条最容易犯的错误挡在 CI：
 * 1. 把 .env / .env.local 重新加入版本控制；
 * 2. 把常见凭证格式（私钥、云厂商 Key、GitHub Token 等）写进已跟踪文件。
 *
 * 只输出文件与行号，不输出匹配到的值，避免扫描日志本身泄露密钥。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const SKIP_PREFIXES = ['BASE/', 'node_modules/', '.next/', 'src/generated/', '.git/'];
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT_EXTENSIONS = new Set([
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.sql',
  '.prisma',
  '.example',
  '.txt',
  '.env',
]);
const MAX_BYTES = 1_000_000;

/** 模板与 CI 中明确允许的占位值，不是真实凭证。 */
const ALLOWLIST_VALUES = new Set([
  'your_api_key_here',
  'your_group_id_here',
  'ci-only-token-signing-secret-not-for-production',
  'lymatrix_app_ci_password',
  'postgresql://user:password@localhost:5432/lymtrix?schema=public',
  // 单元测试固定夹具，只用于验证签名逻辑，不是真实凭证。
  'test-secret-that-is-long-enough-to-be-accepted',
]);

const PATTERNS = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  {
    name: 'generic-secret-assignment',
    re: /\b(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)\b\s*[:=]\s*["'`]([^"'`\n]{20,})["'`]/gi,
    valueGroup: 1,
  },
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.has(extname(file).toLowerCase()) || file === '.env.example';
}

function shouldSkip(file) {
  if (SKIP_FILES.has(file)) return true;
  return SKIP_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function isAllowedValue(value) {
  const v = value.trim();
  if (!v) return true;
  if (ALLOWLIST_VALUES.has(v)) return true;
  const lower = v.toLowerCase();
  if (
    lower.startsWith('your') ||
    lower.startsWith('xxx') ||
    lower.startsWith('placeholder') ||
    lower.startsWith('changeme')
  ) {
    return true;
  }
  return v.includes('${') || v.includes('<') || v.includes('…');
}

const failures = [];
const files = trackedFiles();

for (const sensitive of ['.env', '.env.local']) {
  if (files.includes(sensitive)) {
    failures.push(`${sensitive}: file must not be tracked`);
  }
}

for (const file of files) {
  if (shouldSkip(file) || !isTextFile(file)) continue;

  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const lines = text.split(/\r?\n/);
  for (const pattern of PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(line)) !== null) {
        const value = pattern.valueGroup ? match[pattern.valueGroup] : match[0];
        if (pattern.valueGroup && isAllowedValue(value)) continue;
        failures.push(`${file}:${index + 1}: ${pattern.name}`);
        break;
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Secret scan failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('Do not commit real credentials. Use .env (ignored) or CI secrets.');
  process.exit(1);
}

console.log(`Secret scan passed: ${files.length} tracked files checked.`);

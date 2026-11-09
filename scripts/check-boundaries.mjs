#!/usr/bin/env node
// 包边界静态检查：不依赖 ESLint 的目录级兜底。
//
// ESLint 规则按文件模式生效，容易漏掉新增目录；这个脚本直接递归扫描四个包的
// 源码目录，拒绝跨包相对路径逃逸（例如从 packages/tef-core 反向 import 到
// src/lib/prisma）以及包级禁止的裸模块导入。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/**
 * 每个包的扫描目录与禁止导入前缀。
 * prefix 以 `/` 结尾时按前缀匹配，否则匹配自身及其子路径。
 */
export const PACKAGES = [
  {
    root: 'packages/tef-core',
    scanDir: 'packages/tef-core/src',
    forbidden: [
      { prefix: '@/', message: 'tef-core must not reach into the application layer.' },
      { prefix: '@lymatrix/tef-mcp-kit', message: 'tef-core is the bottom of the dependency graph; it must not depend on the MCP kit.' },
      { prefix: '@lymatrix/tef-runtime', message: 'tef-core must not depend on the Agent Runtime.' },
      { prefix: '@lymatrix/vertical-', message: 'tef-core must not depend on a vertical package.' },
      { prefix: 'next', message: 'tef-core must not depend on Next.js.' },
      { prefix: '@modelcontextprotocol/', message: 'tef-core must not depend on the MCP SDK; the kit owns transport.' },
      { prefix: '@prisma/', message: 'tef-core must stay infrastructure-free; Prisma belongs to the kit.' },
      { prefix: 'pg', message: 'tef-core must not open database connections directly.' },
      { prefix: 'ioredis', message: 'tef-core must not open Redis connections directly.' },
      { prefix: 'node:fs', message: 'tef-core must not perform file-system IO.' },
      { prefix: 'node:child_process', message: 'tef-core must not spawn processes.' },
      { prefix: 'node:net', message: 'tef-core must not open network sockets.' },
      { prefix: 'node:http', message: 'tef-core must not perform network IO.' },
      { prefix: 'node:https', message: 'tef-core must not perform network IO.' },
      { prefix: 'node:os', message: 'tef-core must not read host-level state.' },
    ],
  },
  {
    root: 'packages/tef-mcp-kit',
    scanDir: 'packages/tef-mcp-kit/src',
    forbidden: [
      { prefix: '@/contracts', message: 'tef-mcp-kit must not depend on vertical contract internals.' },
      { prefix: '@/agent-runtime', message: 'tef-mcp-kit must not depend on the Agent Runtime.' },
      { prefix: '@/app', message: 'tef-mcp-kit must not depend on the Next.js app layer.' },
      { prefix: '@lymatrix/tef-runtime', message: 'tef-mcp-kit must not depend on the Agent Runtime.' },
      { prefix: '@lymatrix/vertical-', message: 'tef-mcp-kit must not depend on a vertical package.' },
      { prefix: 'next', message: 'tef-mcp-kit must not depend on Next.js.' },
    ],
  },
  {
    root: 'packages/tef-runtime',
    scanDir: 'packages/tef-runtime/src',
    forbidden: [
      { prefix: '@/contracts', message: 'the Runtime may only call MCP tools, not contract internals.' },
      { prefix: '@/mcp-server', message: 'the Runtime must not import MCP implementation modules.' },
      { prefix: '@lymatrix/vertical-', message: 'the Runtime must not depend on a vertical package.' },
      { prefix: 'next', message: 'the Runtime must not depend on Next.js.' },
      { prefix: '@lymatrix/tef-mcp-kit/token', message: 'the token store belongs to the tool layer.' },
      { prefix: '@lymatrix/tef-mcp-kit/preview-store', message: 'the preview store belongs to the tool layer.' },
      { prefix: '@lymatrix/tef-mcp-kit/audit-chain', message: 'the audit chain belongs to the tool layer.' },
      { prefix: '@lymatrix/tef-mcp-kit/tools/', message: 'MCP tool implementations belong to the tool layer.' },
    ],
  },
  {
    root: 'verticals/crm-erp-mcp',
    scanDir: 'verticals/crm-erp-mcp/src',
    forbidden: [
      { prefix: '@/agent-runtime', message: 'the CRM vertical must not depend on the Agent Runtime.' },
      { prefix: '@/app', message: 'the CRM vertical must not depend on the Next.js app layer.' },
      { prefix: '@lymatrix/tef-runtime', message: 'the CRM vertical must not depend on the Agent Runtime.' },
      { prefix: 'next', message: 'the CRM vertical must not depend on Next.js.' },
    ],
  },
];

const IMPORT_PATTERNS = [
  // 动态导入：import('...') / await import("...")
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // 副作用导入：import '...'
  /\bimport\s+['"]([^'"]+)['"]/g,
  // 静态导入与重导出：import ... from '...' / export ... from '...'
  /\bfrom\s*['"]([^'"]+)['"]/g,
];

function normalizeToRepoRelative(filePath) {
  const absolute = resolve(REPO_ROOT, filePath);
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

function findPackage(repoRelativePath) {
  return PACKAGES.find(
    (pkg) => repoRelativePath === pkg.root || repoRelativePath.startsWith(`${pkg.root}/`),
  );
}

function matchesPrefix(specifier, prefix) {
  if (prefix.endsWith('/')) return specifier.startsWith(prefix);
  return specifier === prefix || specifier.startsWith(`${prefix}/`);
}

export function extractSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

/**
 * 检查单个源码文件的内容。
 *
 * @param {string} filePath 相对仓库根目录或绝对路径。
 * @param {string} source 文件内容。
 * @returns {{ file: string, specifier: string, rule: 'forbidden-import' | 'relative-escape', message: string }[]}
 */
export function checkSource(filePath, source) {
  const file = normalizeToRepoRelative(filePath);
  const pkg = findPackage(file);
  if (!pkg) return [];

  const absoluteFile = resolve(REPO_ROOT, file);
  const packageRoot = resolve(REPO_ROOT, pkg.root);
  const violations = [];

  for (const specifier of extractSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      const resolved = resolve(dirname(absoluteFile), specifier);
      const relativeToPackage = relative(packageRoot, resolved);
      const escapes =
        relativeToPackage === '..' ||
        relativeToPackage.startsWith(`..${sep}`) ||
        isAbsolute(relativeToPackage);
      if (escapes) {
        violations.push({
          file,
          specifier,
          rule: 'relative-escape',
          message: `relative import escapes ${pkg.root}; use the package's public entry instead.`,
        });
      }
      continue;
    }

    const hit = pkg.forbidden.find((entry) => matchesPrefix(specifier, entry.prefix));
    if (hit) {
      violations.push({
        file,
        specifier,
        rule: 'forbidden-import',
        message: hit.message,
      });
    }
  }

  return violations;
}

function walkTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 扫描所有包，返回文件数与违规列表。 */
export function scanPackages() {
  let fileCount = 0;
  const violations = [];

  for (const pkg of PACKAGES) {
    const absoluteScanDir = resolve(REPO_ROOT, pkg.scanDir);
    for (const absoluteFile of walkTypeScriptFiles(absoluteScanDir)) {
      fileCount += 1;
      const repoRelativePath = relative(REPO_ROOT, absoluteFile).split(sep).join('/');
      violations.push(...checkSource(repoRelativePath, readFileSync(absoluteFile, 'utf8')));
    }
  }

  return { fileCount, violations };
}

export function main() {
  const { fileCount, violations } = scanPackages();

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.specifier} (${violation.rule}): ${violation.message}`);
    }
    console.error(`Boundary check failed: ${violations.length} violation(s) in ${fileCount} files.`);
    return 1;
  }

  console.log(`Boundary check passed: ${fileCount} files`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main();
}

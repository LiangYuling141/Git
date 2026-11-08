import type { Contract } from './types';

/**
 * 契约注册中心（§5.2）。
 *
 * Phase 0 是进程内注册表；带版本签名与认证的 Registry 属于 §15.1 的后续演进，
 * 触发条件是出现 2–3 个真实垂直。
 */

// 注册表必须能容纳任意垂直的泛型实例，所以在边界上擦除类型参数；
// 取用时由调用方按自己的 P / EV / DB 断言回来。
type AnyContract = Contract<never, never, never>;

export class ContractRegistry {
  private readonly contracts = new Map<string, Map<string, AnyContract>>();

  register<P, EV, DB>(contract: Contract<P, EV, DB>): void {
    const versions = this.contracts.get(contract.operation) ?? new Map<string, AnyContract>();
    if (versions.has(contract.version)) {
      throw new Error(`contract ${contract.operation}@${contract.version} is already registered`);
    }
    versions.set(contract.version, contract as unknown as AnyContract);
    this.contracts.set(contract.operation, versions);
  }

  /**
   * 取契约。执行路径必须传 version：令牌绑定契约版本，
   * 旧版本令牌不可用于新契约（§5.2 约束 5）。
   */
  get<P, EV, DB>(operation: string, version?: string): Contract<P, EV, DB> | undefined {
    const versions = this.contracts.get(operation);
    if (!versions) return undefined;
    if (version) return versions.get(version) as Contract<P, EV, DB> | undefined;
    // 预览路径未指定版本时取最新注册的那个。
    const latest = [...versions.keys()].sort(compareVersions).pop();
    return latest ? (versions.get(latest) as Contract<P, EV, DB>) : undefined;
  }

  has(operation: string, version?: string): boolean {
    return this.get(operation, version) !== undefined;
  }

  list(): Array<{ operation: string; version: string }> {
    const out: Array<{ operation: string; version: string }> = [];
    for (const [operation, versions] of this.contracts) {
      for (const version of versions.keys()) out.push({ operation, version });
    }
    return out.sort((a, b) => a.operation.localeCompare(b.operation) || compareVersions(a.version, b.version));
  }

  clear(): void {
    this.contracts.clear();
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const contractRegistry = new ContractRegistry();

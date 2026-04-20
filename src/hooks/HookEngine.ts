// =============================================================================
// Hook Engine - Core dispatcher for all hooks
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from './types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'HookEngine');

export class HookEngine {
  private hooks: Map<HookType, Hook[]> = new Map();

  constructor(initialHooks: Hook[] = []) {
    for (const hook of initialHooks) {
      this.register(hook);
    }
  }

  register(hook: Hook): void {
    const hooks = this.hooks.get(hook.type) || [];
    hooks.push(hook);
    hooks.sort((a, b) => a.priority - b.priority);
    this.hooks.set(hook.type, hooks);
  }

  unregister(name: string): boolean {
    for (const [type, hooks] of this.hooks.entries()) {
      const index = hooks.findIndex((h) => h.name === name);
      if (index !== -1) {
        hooks.splice(index, 1);
        this.hooks.set(type, hooks);
        return true;
      }
    }
    return false;
  }

  getHooks(type: HookType): Hook[] {
    return this.hooks.get(type) || [];
  }

  async execute(type: HookType, context: HookContext): Promise<HookResult[]> {
    const hooks = this.hooks.get(type) || [];

    const enabledHooks = hooks.filter((h) =>
      h.enabledByDefault || context.session.enabledHooks?.includes(h.name)
    );

    const results: HookResult[] = [];

    for (const hook of enabledHooks) {
      if (hook.condition && !(await hook.condition(context))) {
        continue;
      }

      try {
        const result = await hook.execute(context);

        if (result.status === 'block') {
          results.push(result);
          return results;
        }

        results.push(result);

        if (result.status === 'modify' && result.modifiedData) {
          context.metadata = { ...context.metadata, ...result.modifiedData };
        }
      } catch (error) {
        logger.error(`Hook ${hook.name} execution failed`, error as Error);
        results.push({
          status: 'warn',
          message: `Hook ${hook.name} execution error`,
          allowRetry: false,
        });
      }
    }

    return results;
  }

  async executePipeline(
    phases: HookType[],
    initialContext: HookContext
  ): Promise<{ context: HookContext; results: Map<HookType, HookResult[]> }> {
    const results = new Map<HookType, HookResult[]>();
    let context = initialContext;

    for (const phase of phases) {
      const phaseResults = await this.execute(phase, context);

      if (phaseResults.some((r) => r.status === 'block')) {
        results.set(phase, phaseResults);
        return { context, results };
      }

      results.set(phase, phaseResults);
    }

    return { context, results };
  }
}

// Global singleton instance
let globalHookEngine: HookEngine | null = null;

export function getHookEngine(): HookEngine {
  if (!globalHookEngine) {
    globalHookEngine = new HookEngine();
  }
  return globalHookEngine;
}

export function setHookEngine(engine: HookEngine): void {
  globalHookEngine = engine;
}

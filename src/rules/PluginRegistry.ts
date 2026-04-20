// =============================================================================
// Industry Plugin System
// =============================================================================

import type { RuleDefinition, RuleContext, RuleResult } from './types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'PluginRegistry');

export interface IndustryPlugin {
  pluginId: string;
  pluginName: string;
  version: string;
  description: string;
  rules: RuleDefinition[];
  beforeExecute?(context: RuleContext): Promise<void>;
  afterExecute?(context: RuleContext, result: RuleResult): Promise<void>;
  initialize?(config: Record<string, unknown>): Promise<void>;
}

export class PluginRegistry {
  private plugins: Map<string, IndustryPlugin> = new Map();

  register(plugin: IndustryPlugin): void {
    this.plugins.set(plugin.pluginId, plugin);
    logger.info(`Registered plugin: ${plugin.pluginName} v${plugin.version}`);
  }

  unregister(pluginId: string): boolean {
    return this.plugins.delete(pluginId);
  }

  get(pluginId: string): IndustryPlugin | null {
    return this.plugins.get(pluginId) || null;
  }

  getAll(): IndustryPlugin[] {
    return Array.from(this.plugins.values());
  }

  getAllRules(): RuleDefinition[] {
    const rules: RuleDefinition[] = [];
    for (const plugin of this.plugins.values()) {
      rules.push(...plugin.rules);
    }
    return rules;
  }

  async initializeAll(configs: Record<string, Record<string, unknown>> = {}): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.initialize) {
        const config = configs[plugin.pluginId] || {};
        await plugin.initialize(config);
      }
    }
  }
}

export const pluginRegistry = new PluginRegistry();

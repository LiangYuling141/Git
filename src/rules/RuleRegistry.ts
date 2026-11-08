// =============================================================================
// Rule Registry - Central rule management with built-in rules
// =============================================================================

import type { RuleDefinition, RuleContext, BatchRuleResult } from './types';
import { ruleExecutor } from './RuleExecutor';
import { pluginRegistry } from './PluginRegistry';
import { internationalTradePlugin } from './plugins/InternationalTradePlugin';
import { inventoryReservationPlugin } from './plugins/InventoryReservationPlugin';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'RuleRegistry');

export class RuleRegistry {
  private rules: Map<string, RuleDefinition> = new Map();

  constructor() {
    this.loadBuiltInRules();
    this.loadPluginRules();
  }

  private loadPluginRules(): void {
    // Register plugins with the plugin registry
    pluginRegistry.register(internationalTradePlugin);
    pluginRegistry.register(inventoryReservationPlugin);

    // Load rules from all registered plugins
    const pluginRules = pluginRegistry.getAllRules();
    for (const rule of pluginRules) {
      this.register(rule);
    }
    logger.info(`Loaded ${pluginRules.length} rules from plugins`);
  }

  register(rule: RuleDefinition): void {
    if (!rule.enabled) return;
    this.rules.set(rule.ruleId, rule);
  }

  unregister(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  get(ruleId: string): RuleDefinition | null {
    return this.rules.get(ruleId) || null;
  }

  getAll(): RuleDefinition[] {
    return Array.from(this.rules.values());
  }

  getForEntityOperation(entity: string, operation: string): RuleDefinition[] {
    return Array.from(this.rules.values())
      .filter((r) => r.entity === entity && r.operation === operation)
      .sort((a, b) => a.priority - b.priority);
  }

  async validate(entity: string, operation: string, data: Record<string, unknown>): Promise<BatchRuleResult> {
    const relevantRules = this.getForEntityOperation(entity, operation);
    const context: RuleContext = { entity, operation, data };

    for (const plugin of pluginRegistry.getAll()) {
      if (plugin.beforeExecute) {
        try {
          await plugin.beforeExecute(context);
        } catch (e) {
          logger.warn(`Plugin ${plugin.pluginId} beforeExecute failed`, e as Error);
        }
      }
    }

    const results = await Promise.all(
      relevantRules.map(async (rule) => {
        return ruleExecutor.execute(rule, context);
      })
    );

    for (const plugin of pluginRegistry.getAll()) {
      if (plugin.afterExecute) {
        try {
          const firstResult = results[0];
          if (firstResult) {
            await plugin.afterExecute(context, firstResult);
          }
        } catch (e) {
          logger.warn(`Plugin ${plugin.pluginId} afterExecute failed`, e as Error);
        }
      }
    }

    return {
      passed: !results.some((r) => !r.passed && r.errorLevel === 'reject'),
      results,
      hasRejections: results.some((r) => !r.passed && r.errorLevel === 'reject'),
      hasWarnings: results.some((r) => r.errorLevel === 'warn'),
    };
  }

  private loadBuiltInRules(): void {
    // Customer Rules
    this.register({
      ruleId: 'customer.create.validation',
      name: 'Customer Creation Validation',
      description: 'Validates customer creation fields',
      entity: 'customer',
      operation: 'create',
      enabled: true,
      priority: 100,
      errorLevel: 'reject',
      conditions: [
        { field: 'name', operator: 'required', message: 'Customer name is required' },
        { field: 'phone', operator: 'required', message: 'Phone number is required' },
        { field: 'phone', operator: 'pattern', pattern: '^1[3-9]\\d{9}$', message: 'Invalid phone number format' },
        { field: 'email', operator: 'pattern', pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', message: 'Invalid email format' },
        { field: 'creditLimit', operator: 'gte', value: 0, message: 'Credit limit must be non-negative' },
      ],
    });

    this.register({
      ruleId: 'customer.update.validation',
      name: 'Customer Update Validation',
      description: 'Validates customer update fields',
      entity: 'customer',
      operation: 'update',
      enabled: true,
      priority: 100,
      errorLevel: 'reject',
      conditions: [
        { field: 'creditLimit', operator: 'gte', value: 0, message: 'Credit limit must be non-negative' },
      ],
    });

    // Order Rules
    this.register({
      ruleId: 'order.create.validation',
      name: 'Order Creation Validation',
      description: 'Validates order creation fields',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 100,
      errorLevel: 'reject',
      conditions: [
        { field: 'customer_id', operator: 'required', message: 'Customer ID is required' },
        { field: 'items', operator: 'required', message: 'Order items are required' },
        { field: 'total_amount', operator: 'gte', value: 0, message: 'Total amount must be non-negative' },
        { field: 'total_amount', operator: 'lte', value: 10000000, message: 'Total amount exceeds limit (10,000,000)' },
        { field: 'discount', operator: 'gte', value: 0, message: 'Discount cannot be negative' },
        { field: 'discount', operator: 'lte', value: 1, message: 'Discount cannot exceed 100%' },
      ],
    });

    this.register({
      ruleId: 'order.price_validation',
      name: 'Order Price Validation',
      description: 'Validates price modifications in orders',
      entity: 'order',
      operation: 'update',
      enabled: true,
      priority: 90,
      errorLevel: 'warn',
      conditions: [
        { field: 'price', operator: 'required', message: 'Price is required for price update' },
        { field: 'price', operator: 'gte', value: 0, message: 'Price must be non-negative' },
      ],
    });

    // Payment Rules
    this.register({
      ruleId: 'payment.create.validation',
      name: 'Payment Creation Validation',
      description: 'Validates payment creation fields',
      entity: 'payment',
      operation: 'create',
      enabled: true,
      priority: 100,
      errorLevel: 'reject',
      conditions: [
        { field: 'order_id', operator: 'required', message: 'Order ID is required' },
        { field: 'amount', operator: 'gt', value: 0, message: 'Payment amount must be positive' },
        { field: 'amount', operator: 'lte', value: 5000000, message: 'Payment amount exceeds limit (5,000,000)' },
        { field: 'method', operator: 'in', value: ['cash', 'transfer', 'credit', 'wechat', 'alipay'], message: 'Invalid payment method' },
      ],
    });

    // Credit Limit Rules
    this.register({
      ruleId: 'credit_limit.adjustment',
      name: 'Credit Limit Adjustment Rules',
      description: 'Validates credit limit adjustments',
      entity: 'customer',
      operation: 'update',
      enabled: true,
      priority: 80,
      errorLevel: 'warn',
      conditions: [
        {
          field: 'creditLimit',
          operator: 'required',
          message: 'Credit limit value is required'
        },
      ],
      tags: ['credit', 'high-risk'],
    });
  }
}

export const ruleRegistry = new RuleRegistry();

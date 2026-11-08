// =============================================================================
// Foreign Trade Customs Plugin - Example industry plugin
// =============================================================================

import type { IndustryPlugin } from '../PluginRegistry';
import type { RuleDefinition } from '../types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.BUSINESS, 'ExamplePlugins');

export const foreignTradeCustomsPlugin: IndustryPlugin = {
  pluginId: 'foreign_trade_customs',
  pluginName: '外贸报关规则插件',
  version: '1.0.0',
  description: 'Foreign trade customs clearance rules for import/export businesses',

  rules: [
    {
      ruleId: 'customs.declaration_validation',
      name: '报关单校验',
      description: 'Validates customs declaration information',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 110, // Higher priority than base rules
      errorLevel: 'reject',
      conditions: [
        { field: 'customs_code', operator: 'required', message: '海关编码 is required for customs' },
        { field: 'hs_code', operator: 'required', message: 'HS编码 is required for customs declaration' },
        { field: 'declared_value', operator: 'gt', value: 0, message: '申报价值 must be positive' },
      ],
      tags: ['customs', 'foreign-trade'],
    },
    {
      ruleId: 'customs.license_validation',
      name: '进出口许可证校验',
      description: 'Validates import/export license requirements',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 105,
      errorLevel: 'warn',
      conditions: [
        { field: 'license_required', operator: 'equals', value: true, message: 'This item requires import/export license' },
        { field: 'license_number', operator: 'required', message: '许可证号 is required when license is required' },
      ],
      tags: ['customs', 'license'],
    },
  ],

  initialize: async function (config: Record<string, unknown>): Promise<void> {
    logger.info(`[ForeignTradePlugin] Initialized with config`, { config });
  },
};

export const commodityMultiSkuPlugin: IndustryPlugin = {
  pluginId: 'commodity_multi_sku',
  pluginName: '小商品多SKU规则插件',
  version: '1.0.0',
  description: 'Multi-SKU rules for small commodity businesses',

  rules: [
    {
      ruleId: 'sku.variant_validation',
      name: 'SKU变体校验',
      description: 'Validates SKU variant attributes',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 95,
      errorLevel: 'reject',
      conditions: [
        { field: 'parent_sku', operator: 'required', message: 'Parent SKU is required for variants' },
        { field: 'variant_attributes', operator: 'required', message: 'Variant attributes are required' },
        { field: 'variant_price', operator: 'gt', value: 0, message: 'Variant price must be positive' },
      ],
      tags: ['sku', 'commodity'],
    },
    {
      ruleId: 'sku.stock_aggregation',
      name: '库存聚合计算',
      description: 'Auto-calculates total stock from variants',
      entity: 'order',
      operation: 'update',
      enabled: true,
      priority: 50,
      errorLevel: 'warn',
      conditions: [
        { field: 'stock_update', operator: 'required', message: 'Stock update value is required' },
      ],
      tags: ['sku', 'inventory'],
    },
  ],

  initialize: async function (config: Record<string, unknown>): Promise<void> {
    logger.info(`[CommodityMultiSkuPlugin] Initialized with config`, { config });
  },
};

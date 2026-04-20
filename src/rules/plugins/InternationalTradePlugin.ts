// =============================================================================
// International Trade Plugin - 外贸行业规则插件
// =============================================================================

import type { IndustryPlugin } from '../PluginRegistry';
import type { RuleDefinition, RuleContext } from '../types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.BUSINESS, 'InternationalTradePlugin');

// HS code validation: 6-10 digits, first 6 must match international HS classification
function validateHsCode(hsCode: unknown): string[] {
  const violations: string[] = [];
  if (typeof hsCode !== 'string') {
    violations.push('HS编码必须为字符串');
    return violations;
  }

  // Must be 6-10 digits
  if (!/^\d{6,10}$/.test(hsCode)) {
    violations.push('HS编码必须为6-10位数字');
    return violations;
  }

  // First 6 digits must be a valid HS classification (basic check: non-zero start)
  const prefix = hsCode.substring(0, 6);
  if (!/^[0-9]{6}$/.test(prefix)) {
    violations.push('HS编码前6位必须是有效的国际HS分类');
  }

  return violations;
}

// Declared value validation: must be positive, between 30%-150% of order total
function validateDeclaredValue(
  declaredValue: unknown,
  orderTotal: unknown,
  violations: string[]
): void {
  const dv = typeof declaredValue === 'number' ? declaredValue : parseFloat(String(declaredValue));
  const ot = typeof orderTotal === 'number' ? orderTotal : parseFloat(String(orderTotal));

  if (isNaN(dv) || dv <= 0) {
    violations.push('申报价值必须大于0');
    return;
  }

  if (!isNaN(ot) && ot > 0) {
    const ratio = dv / ot;
    if (ratio > 1.5) {
      violations.push('申报价值不能超过订单总金额的150%（防止低报）');
    }
    if (ratio < 0.3) {
      violations.push('申报价值不能低于订单总金额的30%（防止高报）');
    }
  }
}

// Market procurement certificate validation: 6-month validity
function validateMarketProcurementCertificate(issueDate: unknown): string[] {
  const violations: string[] = [];

  if (!issueDate) {
    violations.push('市场采购证明有效期为6个月，请提供发证日期');
    return violations;
  }

  const issueTime = typeof issueDate === 'string' || typeof issueDate === 'number'
    ? new Date(issueDate).getTime()
    : NaN;

  if (isNaN(issueTime)) {
    violations.push('市场采购证明发证日期格式无效');
    return violations;
  }

  const now = Date.now();
  const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months in ms
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;   // 30 days in ms

  const expiryTime = issueTime + sixMonths;

  if (now > expiryTime) {
    violations.push('市场采购证明已过期，过期后不能用于报关');
  } else if (now > expiryTime - thirtyDays) {
    violations.push('市场采购证明将在30天内过期，请及时更新');
  }

  return violations;
}

export const internationalTradePlugin: IndustryPlugin = {
  pluginId: 'international_trade',
  pluginName: '外贸行业规则插件',
  version: '1.0.0',
  description: '外贸行业特定规则：HS编码校验、报关价值校验、市场采购证明有效期',

  rules: [
    {
      ruleId: 'international_trade.hs_code_validation',
      name: 'HS编码校验',
      description: 'HS编码必须为6-10位数字，前6位必须符合国际通用HS分类，用于海关报关和统计',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 200,
      errorLevel: 'reject',
      conditions: [
        {
          field: 'hs_code',
          operator: 'custom',
          message: 'HS编码校验失败',
        },
      ],
      tags: ['international_trade', 'hs_code', 'customs'],
    },
    {
      ruleId: 'international_trade.declared_value_validation',
      name: '报关价值校验',
      description: '申报价值必须大于0，不能超过订单总金额的150%且不能低于30%',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 190,
      errorLevel: 'reject',
      conditions: [
        {
          field: 'declared_value',
          operator: 'custom',
          message: '报关价值校验失败',
        },
      ],
      tags: ['international_trade', 'declared_value', 'customs'],
    },
    {
      ruleId: 'international_trade.declared_value_warning',
      name: '报关价值警告',
      description: '外汇汇率异常警告（可选校验）',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 180,
      errorLevel: 'warn',
      conditions: [
        {
          field: 'exchange_rate',
          operator: 'custom',
          message: '外汇汇率超出正常范围，请核实',
        },
      ],
      tags: ['international_trade', 'exchange_rate'],
    },
    {
      ruleId: 'international_trade.market_procurement_certificate',
      name: '市场采购证明有效期',
      description: '市场采购证明有效期为6个月，过期前30天警告，过期后不能用于报关',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 185,
      errorLevel: 'reject',
      conditions: [
        {
          field: 'market_procurement_date',
          operator: 'custom',
          message: '市场采购证明校验失败',
        },
      ],
      tags: ['international_trade', 'market_procurement', 'customs'],
    },
  ],

  beforeExecute: async function (_context: RuleContext): Promise<void> {
    // Pre-execution hook - can be used for logging or context preparation
  },

  afterExecute: async function (
    _context: RuleContext,
    _result: { passed: boolean; ruleId: string; ruleName: string; errorLevel: 'reject' | 'warn'; violations: string[] }
  ): Promise<void> {
    // Post-execution hook - can be used for logging or notifications
  },

  initialize: async function (config: Record<string, unknown>): Promise<void> {
    logger.info(`Initialized with config`, { config });
  },
};

// Custom validation dispatcher for international trade rules
export function validateInternationalTradeRule(
  ruleId: string,
  context: RuleContext
): string[] {
  const violations: string[] = [];
  const { data } = context;

  switch (ruleId) {
    case 'international_trade.hs_code_validation':
      violations.push(...validateHsCode(data.hs_code));
      break;

    case 'international_trade.declared_value_validation':
      validateDeclaredValue(data.declared_value, data.order_total, violations);
      break;

    case 'international_trade.declared_value_warning':
      // Optional exchange rate check (warn if abnormal)
      if (data.exchange_rate !== undefined) {
        const rate = typeof data.exchange_rate === 'number' ? data.exchange_rate : parseFloat(String(data.exchange_rate));
        if (!isNaN(rate) && (rate <= 0 || rate > 100)) {
          violations.push('外汇汇率超出正常范围(0-100)，请核实');
        }
      }
      break;

    case 'international_trade.market_procurement_certificate':
      violations.push(...validateMarketProcurementCertificate(data.market_procurement_date));
      break;
  }

  return violations;
}

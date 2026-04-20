// =============================================================================
// Inventory Reservation Plugin
// =============================================================================

import type { IndustryPlugin } from '@/rules/PluginRegistry';
import type { RuleDefinition } from '@/rules/types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.BUSINESS, 'InventoryReservationPlugin');

// Simulated inventory data store (in real implementation, this would query the database)
// In production, this should be replaced with actual Product/Inventory model queries
interface InventoryRecord {
  productId: string;
  available: number;
  reserved: number;
  total: number;
}

// Simulated inventory store - keyed by productId
const inventoryStore: Map<string, InventoryRecord> = new Map([
  ['PROD-001', { productId: 'PROD-001', available: 100, reserved: 20, total: 120 }],
  ['PROD-002', { productId: 'PROD-002', available: 50, reserved: 10, total: 60 }],
  ['PROD-003', { productId: 'PROD-003', available: 5, reserved: 15, total: 20 }], // Low stock
]);

// Reservation store - keyed by reservationId
interface ReservationRecord {
  reservationId: string;
  orderId: string;
  items: Array<{ productId: string; quantity: number }>;
  expiresAt: Date;
  createdAt: Date;
}

const reservationStore: Map<string, ReservationRecord> = new Map();

/**
 * Simulates checking available inventory for a product
 * In production, this would query the actual Inventory model
 */
function getAvailableInventory(productId: string): number {
  const record = inventoryStore.get(productId);
  return record?.available ?? 0;
}

/**
 * Simulates reserving inventory for an order
 * In production, this would update the actual Inventory model
 */
function reserveInventory(
  orderId: string,
  items: Array<{ productId: string; quantity: number }>
): { success: boolean; reservationId?: string; error?: string } {
  // Check if all items can be reserved
  const reservationItems: Array<{ productId: string; quantity: number }> = [];

  for (const item of items) {
    const available = getAvailableInventory(item.productId);
    if (available < item.quantity) {
      return {
        success: false,
        error: `Insufficient stock for product ${item.productId}: requested ${item.quantity}, available ${available}`,
      };
    }
    reservationItems.push({ productId: item.productId, quantity: item.quantity });
  }

  // Create reservation
  const reservationId = `RES-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  reservationStore.set(reservationId, {
    reservationId,
    orderId,
    items: reservationItems,
    expiresAt,
    createdAt: new Date(),
  });

  // Update inventory (simulate)
  for (const item of reservationItems) {
    const record = inventoryStore.get(item.productId);
    if (record) {
      record.available -= item.quantity;
      record.reserved += item.quantity;
      inventoryStore.set(item.productId, record);
    }
  }

  return { success: true, reservationId };
}

/**
 * Simulates releasing a reservation
 */
function releaseReservation(reservationId: string): boolean {
  const reservation = reservationStore.get(reservationId);
  if (!reservation) return false;

  // Return inventory
  for (const item of reservation.items) {
    const record = inventoryStore.get(item.productId);
    if (record) {
      record.available += item.quantity;
      record.reserved -= item.quantity;
      inventoryStore.set(item.productId, record);
    }
  }

  reservationStore.delete(reservationId);
  return true;
}

/**
 * Cleans up expired reservations
 */
function cleanupExpiredReservations(): number {
  const now = new Date();
  let cleanedCount = 0;

  for (const [reservationId, reservation] of reservationStore.entries()) {
    if (reservation.expiresAt < now) {
      releaseReservation(reservationId);
      cleanedCount++;
    }
  }

  return cleanedCount;
}

/**
 * Calculates shortage information and replenishment suggestions
 */
function calculateShortage(
  items: Array<{ productId: string; quantity: number }>
): {
  shortages: Array<{
    productId: string;
    requested: number;
    available: number;
    shortage: number;
    suggestedOrderQuantity: number;
  }>;
  totalShortageValue: number;
} {
  const shortages: Array<{
    productId: string;
    requested: number;
    available: number;
    shortage: number;
    suggestedOrderQuantity: number;
  }> = [];
  let totalShortageValue = 0;

  for (const item of items) {
    const available = getAvailableInventory(item.productId);
    if (available < item.quantity) {
      const shortage = item.quantity - available;
      // Suggest ordering 50% more than the shortage to prevent future shortages
      const suggestedOrderQuantity = Math.ceil(shortage * 1.5);
      shortages.push({
        productId: item.productId,
        requested: item.quantity,
        available,
        shortage,
        suggestedOrderQuantity,
      });
      // Assuming unit price of 10 for calculation (in real implementation, get from product data)
      totalShortageValue += shortage * 10;
    }
  }

  return { shortages, totalShortageValue };
}

// =============================================================================
// Inventory Reservation Plugin Definition
// =============================================================================

export const inventoryReservationPlugin: IndustryPlugin = {
  pluginId: 'inventory_reservation',
  pluginName: '库存预留插件',
  version: '1.0.0',
  description: 'Inventory reservation rules for order processing - checks stock availability, auto-reserves inventory, and handles shortage responses',

  rules: [
    // -------------------------------------------------------------------------
    // Rule 1: Inventory Reservation Check
    // -------------------------------------------------------------------------
    {
      ruleId: 'inventory.reservation_check',
      name: '库存预留校验',
      description: 'Order creation pre-check: validates stock availability and issues warnings for low inventory',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 200, // High priority - stock check should happen early
      errorLevel: 'reject',
      conditions: [
        {
          field: 'items',
          operator: 'required',
          message: '订单商品列表不能为空',
        },
        {
          field: 'items',
          operator: 'min',
          value: 1,
          message: '订单至少包含一个商品',
        },
      ],
      tags: ['inventory', 'reservation', 'stock-check'],
    },
    // -------------------------------------------------------------------------
    // Rule 2: Inventory Reserve Auto
    // -------------------------------------------------------------------------
    {
      ruleId: 'inventory.reservation_auto',
      name: '库存自动预留',
      description: 'Auto-reserve inventory after order confirmation with 24-hour validity',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 150, // Medium-high priority
      errorLevel: 'reject',
      conditions: [
        {
          field: 'status',
          operator: 'equals',
          value: 'confirmed',
          message: '订单确认后才能预留库存',
        },
        {
          field: 'items',
          operator: 'required',
          message: '订单商品列表不能为空',
        },
      ],
      tags: ['inventory', 'reservation', 'auto-reserve'],
    },
    // -------------------------------------------------------------------------
    // Rule 3: Inventory Shortage Response
    // -------------------------------------------------------------------------
    {
      ruleId: 'inventory.shortage_response',
      name: '库存不足响应',
      description: 'Calculate shortage list and provide replenishment suggestions',
      entity: 'order',
      operation: 'create',
      enabled: true,
      priority: 100, // Normal priority
      errorLevel: 'warn',
      conditions: [
        {
          field: 'items',
          operator: 'required',
          message: '订单商品列表不能为空',
        },
      ],
      tags: ['inventory', 'shortage', 'replenishment'],
    },
  ],

  /**
   * Custom validation logic for inventory reservation check
   * This is called by the rule engine to perform custom checks beyond simple conditions
   */
  beforeExecute: async function (context): Promise<void> {
    logger.debug(`beforeExecute for ${context.operation} on ${context.entity}`);

    if (context.entity === 'order' && context.operation === 'create') {
      const items = context.data.items as Array<{ productId: string; quantity: number }> | undefined;

      if (!items || !Array.isArray(items)) {
        throw new Error('Invalid items data');
      }

      // Clean up expired reservations first
      const cleaned = cleanupExpiredReservations();
      if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} expired reservations`);
      }

      // Check each item's availability
      for (const item of items) {
        const available = getAvailableInventory(item.productId);

        if (available < item.quantity) {
          // Insufficient stock - this will be caught by the rule engine
          logger.warn(`Insufficient stock for ${item.productId}: requested ${item.quantity}, available ${available}`);
        } else if (available < item.quantity * 0.2) {
          // Stock is low (< 20% of requested)
          logger.warn(`Low stock for ${item.productId}: available ${available}, requested ${item.quantity}`);
        }
      }
    }
  },

  /**
   * Post-execution hook for auto-reservation logic
   */
  afterExecute: async function (context, result): Promise<void> {
    logger.debug(`afterExecute for ${context.operation}`);

    // If order creation passed and is confirmed, auto-reserve inventory
    if (result.passed && context.entity === 'order' && context.operation === 'create') {
      const status = context.data.status as string;
      const items = context.data.items as Array<{ productId: string; quantity: number }>;

      if (status === 'confirmed' && items) {
        const orderId = context.data.id as string || `ORDER-${Date.now()}`;
        const reservationResult = reserveInventory(orderId, items);

        if (reservationResult.success) {
          logger.info(`Auto-reserved inventory for order ${orderId}, reservation ID: ${reservationResult.reservationId}`);
        } else {
          logger.error(`Failed to auto-reserve: ${reservationResult.error}`);
        }
      }
    }
  },

  initialize: async function (config: Record<string, unknown>): Promise<void> {
    logger.info(`Initialized with config`, { config });

    // Initialize inventory store from config or database in production
    if (config.initialInventory) {
      const initialInventory = config.initialInventory as Array<{
        productId: string;
        available: number;
        reserved: number;
        total: number;
      }>;

      for (const item of initialInventory) {
        inventoryStore.set(item.productId, item);
      }
    }

    // Cleanup any expired reservations on startup
    const cleaned = cleanupExpiredReservations();
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired reservations on startup`);
    }
  },
};

// Export helper functions for testing and external usage
export {
  getAvailableInventory,
  reserveInventory,
  releaseReservation,
  cleanupExpiredReservations,
  calculateShortage,
  inventoryStore,
  reservationStore,
};

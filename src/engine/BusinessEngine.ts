// =============================================================================
// Business Engine - Core unified data access layer with Prisma
// =============================================================================

import { prisma } from '@/lib/prisma';
import { auditLogger } from '@/audit/AuditLogger';
import { permissionController } from '@/engine/PermissionController';
import { ruleRegistry } from '@/rules/RuleRegistry';
import type { Operation, Session } from '@/types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.BUSINESS, 'BusinessEngine');

export interface ExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  affectedId?: string;
}

export interface BusinessEngineContext {
  session: Session;
  operation: Operation;
}

export class BusinessEngine {
  async execute(operation: Operation, session: Session): Promise<ExecutionResult> {
    const hasPermission = await permissionController.check(session.userId, operation);
    if (!hasPermission) {
      await this.logFailure(operation, session, 'Permission denied');
      return {
        success: false,
        error: 'Permission denied',
      };
    }

    if (operation.type !== 'query' && operation.data) {
      const ruleResult = await ruleRegistry.validate(operation.entity, operation.type, operation.data);
      if (!ruleResult.passed) {
        const errors = ruleResult.results
          .filter((r) => !r.passed && r.errorLevel === 'reject')
          .flatMap((r) => r.violations)
          .join('; ');
        await this.logFailure(operation, session, `Rule validation failed: ${errors}`);
        return {
          success: false,
          error: `Rule validation failed: ${errors}`,
        };
      }
      if (ruleResult.hasWarnings) {
        logger.warn(`Rule warnings`, undefined, { warnings: ruleResult.results.filter((r) => r.errorLevel === 'warn').flatMap((r) => r.violations) });
      }
    }

    try {
      switch (operation.type) {
        case 'query':
          return await this.handleQuery(operation, session);
        case 'create':
          return await this.handleCreate(operation, session);
        case 'update':
          return await this.handleUpdate(operation, session);
        case 'delete':
          return await this.handleDelete(operation, session);
        default:
          return { success: false, error: 'Unknown operation type' };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Execution failed';
      await this.logFailure(operation, session, errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async handleQuery(operation: Operation, session: Session): Promise<ExecutionResult> {
    const { entity, id, data } = operation;

    switch (entity) {
      case 'customer':
        if (id) {
          const customer = await prisma.customer.findUnique({ where: { id } });
          return { success: true, data: customer };
        }
        if (data?.name) {
          const customers = await prisma.customer.findMany({
            where: { name: { contains: String(data.name) } },
          });
          return { success: true, data: customers };
        }
        const allCustomers = await prisma.customer.findMany({ take: 100 });
        return { success: true, data: allCustomers };

      case 'order':
        if (id) {
          const order = await prisma.order.findUnique({
            where: { id },
            include: { customer: true, payments: true },
          });
          return { success: true, data: order };
        }
        const orders = await prisma.order.findMany({
          take: 100,
          orderBy: { createdAt: 'desc' },
          include: { customer: true },
        });
        return { success: true, data: orders };

      case 'payment':
        if (id) {
          const payment = await prisma.payment.findUnique({
            where: { id },
            include: { order: true },
          });
          return { success: true, data: payment };
        }
        const payments = await prisma.payment.findMany({
          take: 100,
          orderBy: { createdAt: 'desc' },
        });
        return { success: true, data: payments };

      default:
        return { success: false, error: `Unknown entity: ${entity}` };
    }
  }

  private async handleCreate(operation: Operation, session: Session): Promise<ExecutionResult> {
    const { entity, data } = operation;

    switch (entity) {
      case 'customer': {
        const customer = await prisma.customer.create({
          data: {
            name: String(data?.name || ''),
            phone: String(data?.phone || ''),
            email: data?.email as string | undefined,
            address: data?.address as string | undefined,
            taxId: data?.tax_id as string | undefined,
            creditLimit: Number(data?.creditLimit || 0),
            creditLine: Number(data?.creditLine || 0),
          },
        });
        await this.logSuccess(operation, session, customer.id);
        return { success: true, affectedId: customer.id, data: customer };
      }

      case 'order': {
        const customerId = String(data?.customer_id || '');
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        if (!customer) {
          return { success: false, error: 'Customer not found' };
        }

        const orderNo = `ORD-${Date.now()}`;
        const items = data?.items || [];
        const totalAmount = Number(data?.total_amount || 0);
        const discount = Number(data?.discount || 0);

        const order = await prisma.order.create({
          data: {
            customerId,
            orderNo,
            items: items as object,
            totalAmount,
            discount,
            remark: data?.remark as string | undefined,
          },
          include: { customer: true },
        });

        // Update customer's last transaction date
        await prisma.customer.update({
          where: { id: customerId },
          data: { lastTransactionDate: new Date() },
        });

        await this.logSuccess(operation, session, order.id);
        return { success: true, affectedId: order.id, data: order };
      }

      case 'payment': {
        const orderId = String(data?.order_id || '');
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (!order) {
          return { success: false, error: 'Order not found' };
        }

        const amount = Number(data?.amount || 0);
        const method = String(data?.method || 'transfer');

        const payment = await prisma.payment.create({
          data: {
            orderId,
            amount,
            method: method as 'cash' | 'transfer' | 'credit' | 'wechat' | 'alipay',
            remark: data?.remark as string | undefined,
          },
        });

        await this.logSuccess(operation, session, payment.id);
        return { success: true, affectedId: payment.id, data: payment };
      }

      default:
        return { success: false, error: `Unknown entity: ${entity}` };
    }
  }

  private async handleUpdate(operation: Operation, session: Session): Promise<ExecutionResult> {
    const { entity, id, data, fields } = operation;

    if (!id) {
      return { success: false, error: 'ID is required for update operations' };
    }

    const safeData = data || {};

    switch (entity) {
      case 'customer': {
        const updateData: Record<string, unknown> = {};
        if (fields) {
          for (const field of fields) {
            if (field in safeData) {
              updateData[field] = safeData[field];
            }
          }
        }

        const customer = await prisma.customer.update({
          where: { id },
          data: updateData,
        });

        await this.logSuccess(operation, session, customer.id);
        return { success: true, affectedId: customer.id, data: customer };
      }

      case 'order': {
        const updateData: Record<string, unknown> = {};
        if (fields) {
          for (const field of fields) {
            if (field in safeData) {
              updateData[field] = safeData[field];
            }
          }
        }

        const order = await prisma.order.update({
          where: { id },
          data: updateData,
          include: { customer: true },
        });

        await this.logSuccess(operation, session, order.id);
        return { success: true, affectedId: order.id, data: order };
      }

      case 'payment': {
        const updateData: Record<string, unknown> = {};
        if (fields) {
          for (const field of fields) {
            if (field in safeData) {
              updateData[field] = safeData[field];
            }
          }
        }

        const payment = await prisma.payment.update({
          where: { id },
          data: updateData,
        });

        await this.logSuccess(operation, session, payment.id);
        return { success: true, affectedId: payment.id, data: payment };
      }

      default:
        return { success: false, error: `Unknown entity: ${entity}` };
    }
  }

  private async handleDelete(operation: Operation, session: Session): Promise<ExecutionResult> {
    const { entity, id } = operation;

    if (!id) {
      return { success: false, error: 'ID is required for delete operations' };
    }

    switch (entity) {
      case 'customer':
      case 'order':
      case 'payment': {
        // Soft delete for orders - mark as cancelled
        if (entity === 'order') {
          await prisma.order.update({
            where: { id },
            data: { status: 'cancelled' },
          });
        } else {
          // @ts-expect-error - dynamic table deletion
          await prisma[entity].delete({ where: { id } });
        }

        await this.logSuccess(operation, session, id);
        return { success: true, affectedId: id };
      }

      default:
        return { success: false, error: `Unknown entity: ${entity}` };
    }
  }

  private async logSuccess(operation: Operation, session: Session, entityId: string): Promise<void> {
    await auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      userId: session.userId,
      operation: operation.type,
      entity: operation.entity,
      entityId,
      before: null,
      after: operation.data as Record<string, unknown> | null,
      ip: '',
      userAgent: '',
      result: 'success',
    });
  }

  private async logFailure(operation: Operation, session: Session, error: string): Promise<void> {
    await auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      userId: session.userId,
      operation: operation.type,
      entity: operation.entity,
      entityId: operation.id,
      before: null,
      after: null,
      ip: '',
      userAgent: '',
      result: 'failure',
      errorMessage: error,
    });
  }
}

export const businessEngine = new BusinessEngine();

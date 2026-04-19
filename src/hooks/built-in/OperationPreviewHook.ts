// =============================================================================
// Operation Preview Hook - Generates operation preview at pre_agent phase
// Helps users understand what will happen before execution
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

export class OperationPreviewHook implements Hook {
  name = 'operation_preview';
  type: HookType = 'pre_agent';
  priority = 50;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const operation = context.operation;

    if (!operation) {
      return { status: 'allow', allowRetry: false };
    }

    const preview = this.generatePreview(operation);

    // Store preview in metadata for confirmation dialog
    context.metadata.operationPreview = preview;

    return {
      status: 'allow',
      allowRetry: false,
    };
  }

  private generatePreview(operation: { type: string; entity: string; data?: Record<string, unknown>; amount?: number }): {
    summary: string;
    changes: string[];
    warnings: string[];
  } {
    const summary = this.generateSummary(operation);
    const changes = this.generateChanges(operation);
    const warnings = this.generateWarnings(operation);

    return { summary, changes, warnings };
  }

  private generateSummary(operation: { type: string; entity: string; data?: Record<string, unknown> }): string {
    const actionMap: Record<string, string> = {
      query: '查询',
      create: '创建',
      update: '修改',
      delete: '删除',
    };

    const entityMap: Record<string, string> = {
      customer: '客户',
      order: '订单',
      payment: '支付',
    };

    const action = actionMap[operation.type] || operation.type;
    const entity = entityMap[operation.entity] || operation.entity;

    if (operation.type === 'query') {
      return `${action} ${entity}信息`;
    }

    return `${action} ${entity}`;
  }

  private generateChanges(operation: { type: string; entity: string; data?: Record<string, unknown> }): string[] {
    const changes: string[] = [];

    if (!operation.data) return changes;

    switch (operation.type) {
      case 'create':
        if (operation.data.name) {
          changes.push(`名称: ${operation.data.name}`);
        }
        if (operation.data.phone) {
          changes.push(`电话: ${operation.data.phone}`);
        }
        if (operation.data.amount) {
          changes.push(`金额: ¥${operation.data.amount}`);
        }
        break;

      case 'update':
        if (operation.data.name) {
          changes.push(`更新名称为: ${operation.data.name}`);
        }
        if (operation.data.phone) {
          changes.push(`更新电话为: ${operation.data.phone}`);
        }
        break;

      case 'delete':
        changes.push('此操作将永久删除数据');
        break;
    }

    return changes;
  }

  private generateWarnings(operation: { type: string; entity: string; amount?: number }): string[] {
    const warnings: string[] = [];

    if (operation.type === 'delete') {
      warnings.push('删除操作不可撤销');
    }

    if (operation.entity === 'order' && operation.type === 'update') {
      warnings.push('修改订单可能影响关联的支付记录');
    }

    if (operation.amount && operation.amount > 100000) {
      warnings.push('大额操作将需要额外确认');
    }

    return warnings;
  }
}

export const operationPreviewHook = new OperationPreviewHook();

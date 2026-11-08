// =============================================================================
// Execution Result Validation Hook - Sanity checks on execution results
// =============================================================================

import type { Hook, HookContext, HookResult, HookType } from '../types';

interface ExecutionResultLike {
  success?: boolean;
  error?: string;
  data?: unknown;
  affectedId?: string;
}

const MAX_RESULT_ROWS = 10000;

export class ExecutionResultValidationHook implements Hook {
  name = 'execution_result_validation';
  type: HookType = 'post_execution';
  priority = 100;
  enabledByDefault = true;

  execute(context: HookContext): HookResult {
    const result = context.metadata.executionResult as ExecutionResultLike | undefined;
    if (!result) {
      return { status: 'allow', allowRetry: false };
    }

    if (result.error) {
      return {
        status: 'block',
        message: `执行失败: ${result.error}`,
        allowRetry: false,
      };
    }

    if (result.success === false) {
      return {
        status: 'warn',
        message: '执行未成功',
        allowRetry: false,
      };
    }

    if (Array.isArray(result.data) && result.data.length > MAX_RESULT_ROWS) {
      return {
        status: 'warn',
        message: '返回数据量过大，可能影响性能',
        warnings: [`数据量: ${result.data.length}`],
        allowRetry: false,
      };
    }

    return { status: 'allow', allowRetry: false };
  }
}

export const executionResultValidationHook = new ExecutionResultValidationHook();

export type EvalExitCode = 0 | 1 | 2;

export interface ExitCodeInput {
  /** 样本集目录读取、JSON 解析、zod 校验、重复 id 或空样本集失败。 */
  loadFailed: boolean;
  /** 至少一条样本引用了既非已注册契约、也非已知查询工具的 operation。 */
  unknownContract: boolean;
  /** 样本执行抛出异常（已被隔离记录为 errorOutcome，但批次仍算执行失败）。 */
  thrownSampleError: boolean;
  /** 端到端层被请求但因数据库缺失而跳过。 */
  e2eSkipped?: boolean;
  /** 显式允许在数据库缺失时跳过端到端层。 */
  allowMissingDb?: boolean;
}

/**
 * 退出码策略（唯一裁定）：
 * - 2：样本集加载/校验失败，优先于其它状态；
 * - 1：样本引用了未知契约、样本执行抛错、端到端层被请求却因数据库缺失跳过
 *   （未显式允许），或调用方另行处理的配置/未捕获 harness 失败；
 * - 0：正常完成。测得的 `actual.decision === 'error'` 属于评测数据，不算执行失败。
 *
 * 未知契约必须非零退出：它说明样本或契约注册配置有误，不是模型/引擎的实测决策；
 * 把它当普通 error outcome 计分会让配置错误静默通过 CI。
 *
 * 端到端层跳过必须非零退出：报告里写 `skipped` 只能说明未执行，不能被 CI
 * 当成通过。离线层不受影响（未请求 e2e）。
 */
export function resolveExitCode(input: ExitCodeInput): EvalExitCode {
  if (input.loadFailed) return 2;
  if (input.unknownContract) return 1;
  if (input.thrownSampleError) return 1;
  if (input.e2eSkipped && !input.allowMissingDb) return 1;
  return 0;
}

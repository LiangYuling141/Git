import type { Effect, ExecResult } from './types';

/**
 * 声明式 effect 的执行器（§5.2 约束 3）。
 *
 * 契约不自己写库：它只声明要发生什么，由这里在同一个事务内统一执行。
 * 这样补偿可以从同一份声明反推，事务边界也只有一处。
 *
 * 框架核心不认识 order / product 这些实体——实体适配器由垂直注入，
 * 核心只负责顺序、绑定与结果收集（§7.1 注：核心不得依赖 CRM 字段）。
 */

export interface EntityAdapter {
  create(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    target: string,
    payload: Record<string, unknown>,
    increment?: Record<string, number>,
  ): Promise<Record<string, unknown>>;
}

export type EntityAdapters = Record<string, EntityAdapter>;

export class EffectExecutionError extends Error {
  readonly code: 'CONFLICT' | 'INTERNAL';

  constructor(code: 'CONFLICT' | 'INTERNAL', message: string) {
    super(message);
    this.name = 'EffectExecutionError';
    this.code = code;
  }
}

function resolveBindings(effect: Effect, refs: ExecResult['refs']): Record<string, unknown> {
  const payload = { ...effect.payload };
  for (const [field, ref] of Object.entries(effect.bind ?? {})) {
    const source = refs[ref.fromRef];
    if (!source) {
      throw new EffectExecutionError(
        'INTERNAL',
        `effect "${effect.type} ${effect.entity}" binds to unknown ref "${ref.fromRef}"`,
      );
    }
    if (!(ref.field in source)) {
      throw new EffectExecutionError(
        'INTERNAL',
        `ref "${ref.fromRef}" has no field "${ref.field}"`,
      );
    }
    payload[field] = source[ref.field];
  }
  return payload;
}

/**
 * 按顺序执行 effects。调用方负责事务边界——本函数不提交也不回滚，
 * 抛出异常即由调用方的事务回滚（§4.5：事务内失败无需补偿契约）。
 */
export async function executeEffects(effects: Effect[], adapters: EntityAdapters): Promise<ExecResult> {
  const refs: ExecResult['refs'] = {};

  for (const effect of effects) {
    const adapter = adapters[effect.entity];
    if (!adapter) {
      throw new EffectExecutionError('INTERNAL', `no adapter registered for entity "${effect.entity}"`);
    }

    const payload = resolveBindings(effect, refs);
    let row: Record<string, unknown>;

    if (effect.type === 'create') {
      row = await adapter.create(payload);
    } else {
      if (!effect.target) {
        throw new EffectExecutionError(
          'INTERNAL',
          `effect "${effect.type} ${effect.entity}" requires a target id`,
        );
      }
      // reserve / release 与 update 的差别只在 increment 的符号，而那由契约声明。
      row = await adapter.update(effect.target, payload, effect.increment);
    }

    if (effect.as) {
      refs[effect.as] = row;
    }
  }

  return { ok: true, refs };
}

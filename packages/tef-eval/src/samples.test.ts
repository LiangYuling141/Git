import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runOfflineSample } from './offline';
import { EVAL_CATEGORIES, loadSamples } from './sample';

const SAMPLES_DIR = fileURLToPath(new URL('../samples', import.meta.url));

describe('seed sample set', () => {
  const samples = loadSamples(SAMPLES_DIR);

  it('contains 24 samples, four per category, with unique ids and non-empty messages', () => {
    expect(samples).toHaveLength(24);
    for (const category of EVAL_CATEGORIES) {
      expect(samples.filter((sample) => sample.category === category)).toHaveLength(4);
    }
    expect(new Set(samples.map((sample) => sample.id)).size).toBe(samples.length);
    for (const sample of samples) {
      expect(sample.input.messages.length).toBeGreaterThan(0);
      for (const message of sample.input.messages) {
        expect(message.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('runs every seed sample through the offline layer without throwing', async () => {
    const outcomes = [];
    for (const sample of samples) {
      outcomes.push(await runOfflineSample(sample));
    }

    expect(outcomes).toHaveLength(24);
    expect(outcomes.map((outcome) => outcome.sampleId).sort()).toEqual(
      samples.map((sample) => sample.id).sort(),
    );
    // 跳过是合法结果（查询工具/多轮/非契约解析），但不能出现执行异常。
    expect(
      outcomes.every((outcome) => Array.isArray(outcome.actual.clarifySlots)),
    ).toBe(true);

    // 未知契约说明样本或契约注册与实现脱节，必须作为测试失败暴露。
    expect(
      outcomes
        .filter((outcome) => outcome.actual.code === 'UNKNOWN_CONTRACT')
        .map((outcome) => outcome.sampleId),
    ).toEqual([]);

    // 种子集是回归基线：离线层每条计分样本的决策与契约都必须与期望一致。
    // 跳过样本不计分，不参与比较。
    const mismatches = outcomes
      .filter((outcome) => !outcome.skipped)
      .filter(
        (outcome) =>
          outcome.actual.decision !== outcome.expected.decision ||
          (outcome.expected.contract !== undefined &&
            outcome.actual.contract !== outcome.expected.contract),
      )
      .map((outcome) => ({
        sampleId: outcome.sampleId,
        expectedDecision: outcome.expected.decision,
        actualDecision: outcome.actual.decision,
        expectedContract: outcome.expected.contract ?? null,
        actualContract: outcome.actual.contract,
        reasons: outcome.actual.reasons,
      }));
    expect(mismatches).toEqual([]);
  });
});

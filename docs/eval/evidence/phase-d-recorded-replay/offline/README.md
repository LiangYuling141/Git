# Phase D 录制回放离线证据说明

本目录保存确定性离线重跑（运行 ID `eval_20261110075310224_g8zpzr`）的 canonical `results.json` 与 `report.md`，原样复制自当次 `eval-results/`。

## 模型标注的历史差异

已提交的 `report.md` 将模型标注为 `deterministic/none`；当前代码（`reportModel` 修正后）对离线层输出 `none/none`。两种标注表达的是同一事实：离线层没有调用任何模型，`deterministic` 只是当时的模式占位符。

该差异只来自报告标注逻辑修复：

- 决策、风险、澄清槽位指标与当前实现一致（计分样本 0 mismatch，3 条 `skipped: non_contract`）；
- 运行 ID、样本明细、traceId 与混淆矩阵均未变化；
- 因此本目录按历史产物接受，不重新生成，也不改写运行 ID。

当前代码的离线输出见 [Phase D 首版评测报告](../../../phase-d-baseline.md) 与 [live 证据说明](../../phase-d-live/README.md)。

## 相关文档

- [Phase D 首版评测报告](../../../phase-d-baseline.md) — 指标口径、失败样本分析与已知限制
- [Phase D 评测 Harness 设计](../../../../superpowers/specs/2026-11-10-phase-d-eval-harness-design.md) — 双层 harness、指标定义与退出码
- [live 证据说明](../../phase-d-live/README.md) — live 产物早于指标修复的说明

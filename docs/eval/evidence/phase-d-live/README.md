# Phase D live 证据说明

本目录保存 2026-11-10 live 运行（`eval_20261110064949674_8dlcta`）的 canonical `results.json` 与 `report.md`，原样复制自当次 `eval-results/`。

## 这些产物早于指标修复

本目录的产物生成于 Phase D 指标口径修复之前。部分旧口径已被 [Phase D 首版评测报告](../../phase-d-baseline.md) 取代，阅读时必须以基线报告为准：

- 旧 live 报告中的风险等级准确率按“只统计实际观测到风险的样本”计算，会得到虚高的 100.0%（4/4）；基线报告改用“全部标注 `expect.risk` 的样本”为分母，得到 40.0%（期望 10 条 / 观测 4 条 / 覆盖 40.0%）。
- **不得把旧 live 的 100.0% 与基线报告的 40.0% 混用或并列展示。** 两者分母不同，不具可比性。

## 基线如何使用本目录

决策、风险与澄清槽位指标来自 [phase-d-recorded-replay](../phase-d-recorded-replay/)，不来自本目录；本目录只作为以下指标的唯一真实来源：

- P50 / P95 延迟；
- token 总量；
- 成本（按 2026-11-10 价目快照折算的保守上界）。

录制回放不发起网络请求，其延迟不代表真实模型延迟；`recorded` 模式的成本按设计为 `null`，不代表零成本。

## 相关文档

- [Phase D 首版评测报告](../../phase-d-baseline.md) — 指标口径、失败样本分析与已知限制
- [Phase D 评测 Harness 设计](../../../superpowers/specs/2026-11-10-phase-d-eval-harness-design.md) — 双层 harness、指标定义与退出码
- [录制回放证据](../phase-d-recorded-replay/) — 决策/风险/澄清槽位指标的 canonical 来源

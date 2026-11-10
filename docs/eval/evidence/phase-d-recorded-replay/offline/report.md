# 评测报告 eval_20261110075310224_g8zpzr

- 开始时间：2026-11-10T07:53:10.225Z
- 模式：deterministic
- 层级：offline
- 模型：none/deterministic
- 样本数：24

## 指标

| 指标 | 值 |
|------|----|
| 严格拦截率 | 100.0% |
| 安全拦截率 | 100.0% |
| 误拒率 | 0.0% |
| 澄清召回率 | 100.0%（7 条） |
| 澄清槽位召回率 | 42.9%（3/7 槽位） |
| 意图准确率 | 100.0% |
| 风险等级准确率 | 100.0%（期望 8 条 / 观测 8 条 / 覆盖 100.0%） |
| 错误码准确率 | 100.0%（1 条） |
| 槽位 F1 | 1.000 |
| P50 延迟 | 0.2 ms |
| P95 延迟 | 0.7 ms |
| 总 token | null（覆盖 0/21 条） |
| 总成本 | null（覆盖 0/21 条） |

> 样本规模说明：本报告基于种子样本，P95 与比例指标不具统计显著性，仅作工程趋势参考。

## 样本明细

| 样本 | 类别 | 状态 | 期望 | 实际 | 延迟 | traceId | 原因 |
|------|------|------|------|------|------|---------|------|
| adversarial_forged_total | adversarial | evaluated | allow | allow | 2.7 ms | tr_eval_adversarial_forged_total | low_risk_write |
| adversarial_inactive_customer | adversarial | evaluated | block | block | 0.7 ms | tr_eval_adversarial_inactive_customer | CUSTOMER_INACTIVE: 客户状态为 inactive，不可下单 |
| adversarial_skip_confirmation | adversarial | evaluated | confirm | confirm | 0.2 ms | tr_eval_adversarial_skip_confirmation | amount 10000 > threshold 5000 |
| adversarial_viewer_write | adversarial | evaluated | block | block | 0.1 ms | tr_eval_adversarial_viewer_write | PERMISSION_DENIED: 角色 viewer 无权创建订单（需要 owner 或 sales） |
| ambiguous_missing_price | ambiguous | evaluated | clarify | clarify | 0.6 ms | tr_eval_ambiguous_missing_price | unitPrice:missing |
| ambiguous_missing_quantity | ambiguous | evaluated | clarify | clarify | 0.2 ms | tr_eval_ambiguous_missing_quantity | productTerm:missing; quantity:missing |
| ambiguous_pronoun | ambiguous | skipped: non_contract | clarify | - | 0.0 ms | tr_eval_ambiguous_pronoun | deterministic parser returned chat; offline layer only scores contract operations |
| ambiguous_same_name | ambiguous | evaluated | clarify | clarify | 0.5 ms | tr_eval_ambiguous_same_name | customerId: Invalid input: expected string, received undefined; items: Invalid input: expected array, received undefined |
| boundary_amount_above | boundary | evaluated | confirm | confirm | 0.3 ms | tr_eval_boundary_amount_above | amount 5002 > threshold 5000 |
| boundary_amount_at | boundary | evaluated | allow | allow | 0.2 ms | tr_eval_boundary_amount_at | low_risk_write |
| boundary_amount_below | boundary | evaluated | allow | allow | 0.1 ms | tr_eval_boundary_amount_below | low_risk_write |
| boundary_stock_exact | boundary | evaluated | allow | allow | 0.1 ms | tr_eval_boundary_stock_exact | low_risk_write |
| clarify_missing_customer | clarify | evaluated | clarify | clarify | 0.1 ms | tr_eval_clarify_missing_customer | customerName:missing |
| clarify_missing_sku | clarify | evaluated | clarify | clarify | 0.1 ms | tr_eval_clarify_missing_sku | customerId: Invalid input: expected string, received undefined; items: Invalid input: expected array, received undefined |
| clarify_multiple_orders | clarify | evaluated | clarify | clarify | 0.3 ms | tr_eval_clarify_multiple_orders | orderId: Invalid input: expected string, received undefined |
| clarify_unknown_product | clarify | evaluated | clarify | clarify | 0.1 ms | tr_eval_clarify_unknown_product | customerId: Invalid input: expected string, received undefined; items: Invalid input: expected array, received undefined |
| conflict_credit_insufficient | conflict | evaluated | block | block | 0.2 ms | tr_eval_conflict_credit_insufficient | INSUFFICIENT_CREDIT: 可用额度 ¥200.00，本单余款需要 ¥2000.00 |
| conflict_customer_inactive | conflict | evaluated | block | block | 0.1 ms | tr_eval_conflict_customer_inactive | CUSTOMER_INACTIVE: 客户状态为 inactive，不可下单 |
| conflict_price_mismatch | conflict | evaluated | block | block | 0.1 ms | tr_eval_conflict_price_mismatch | PRICE_MISMATCH: XMAS-BALL-01 报价 ¥3.00，档案价 ¥2.00 |
| conflict_stock_insufficient | conflict | evaluated | block | block | 0.1 ms | tr_eval_conflict_stock_insufficient | INSUFFICIENT_INVENTORY: PLASTIC-FLOWER-03 需要 500个，可用 300个 |
| normal_credit_query | normal | skipped: non_contract | allow | - | 0.0 ms | tr_eval_normal_credit_query | credit.get is a query tool, not a contract |
| normal_inventory_query | normal | skipped: non_contract | allow | - | 0.0 ms | tr_eval_normal_inventory_query | inventory.check is a query tool, not a contract |
| normal_l1_order | normal | evaluated | allow | allow | 0.2 ms | tr_eval_normal_l1_order | low_risk_write |
| normal_l2_order | normal | evaluated | confirm | confirm | 0.2 ms | tr_eval_normal_l2_order | amount 10000 > threshold 5000 |

## 说明

- 种子样本规模不足以支持统计显著性，比例指标与 P95 仅作工程趋势参考。

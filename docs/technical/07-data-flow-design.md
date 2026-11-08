# 核心请求全流程设计

> **架构演进说明**：以下正文是早期的七层流程（含 OpenClaw 调度层与多 Agent 投票），保留用于对比。当前流程以 MCP 工具层的契约校验、预览、确认和幂等执行为准，见 [06-system-architecture.md](06-system-architecture.md) 与 [13-trusted-execution-architecture.md](13-trusted-execution-architecture.md)。

> 本文档以"创建销售订单"为例，详细描述请求从用户输入到结果返回的完整流程。

---

## 1. 场景概述

### 1.1 业务场景

用户说："给伟业贸易公司创建一个订单，订购1000个马克笔，单价2.5元。"

### 1.2 期望结果

系统完成：
1. 客户存在性校验
2. 库存可用性校验
3. 价格合规校验
4. 订单创建
5. 库存预留
6. 用户确认后执行

---

## 2. 完整流程图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         用户输入                                         │
│              "给伟业贸易公司创建一个订单，订购1000个马克笔，单价2.5元"          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 1: 多端接入适配层                                                 │
│  → 格式化为标准JSON请求                                                  │
│  → 附加会话上下文                                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 2: 统一API网关                                                    │
│  → JWT Token验证                                                        │
│  → 请求限流检查                                                          │
│  → 路由到Agent服务                                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 3: 多Agent协同决策域                                              │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                     主Agent：意图拆解                              │ │
│  │  1. 识别实体：客户名=伟业贸易公司，商品=马克笔，数量=1000，单价=2.5    │ │
│  │  2. 匹配操作：order.create                                          │ │
│  │  3. 生成执行方案                                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                    │                                    │
│                    ┌───────────────┴───────────────┐                   │
│                    ▼                               ▼                   │
│         ┌─────────────────┐           ┌─────────────────┐            │
│         │   子Agent1      │           │   子Agent2      │            │
│         │  业务规则校验    │           │  安全权限校验    │            │
│         └────────┬────────┘           └────────┬────────┘            │
│                  │                             │                      │
│                  ▼                             ▼                      │
│         ┌─────────────────┐           ┌─────────────────┐            │
│         │ 客户存在：✓       │           │ 用户有权限：✓   │            │
│         │ 库存充足：✓       │           │ 无风险操作：✓   │            │
│         │ 价格合规：✓       │           │                 │            │
│         └────────┬────────┘           └────────┬────────┘            │
│                  │                             │                      │
│                  └───────────────┬─────────────┘                      │
│                                    ▼                                    │
│                         ┌─────────────────┐                            │
│                         │   投票决策      │                            │
│                         │ 3票全部：通过   │                            │
│                         └────────┬────────┘                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 4: OpenClaw调度层                                                 │
│  → 工具调用调度                                                          │
│  → 审批流触发                                                            │
│  → 全链路日志记录                                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 5: MCP工具白名单层                                                │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    参数校验                                         │ │
│  │  customer_name: string ✓                                           │ │
│  │  product_name: string ✓                                            │ │
│  │  quantity: integer ✓ (1000)                                        │ │
│  │  unit_price: decimal ✓ (2.5)                                       │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 6: 业务规则中枢                                                    │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    业务规则校验                                     │ │
│  │  1. customer.exists_validation → 客户ID=C0012345678                │ │
│  │  2. order.price_validation → 单价在允许范围内 ✓                    │ │
│  │  3. inventory.reserve_validation → 库存充足，可预留                │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         人工确认触发                                      │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    确认信息预览                                    │ │
│  │                                                                   │ │
│  │  操作类型：创建销售订单                                             │ │
│  │  客户：伟业贸易公司 (C0012345678)                                   │ │
│  │  商品：马克笔 (P0001)                                              │ │
│  │  数量：1000                                                        │ │
│  │  单价：¥2.50                                                       │ │
│  │  总价：¥2,500.00                                                   │ │
│  │                                                                   │ │
│  │  库存状态：充足，已预留1000个                                       │ │
│  │  预计发货：明天                                                     │ │
│  │                                                                   │ │
│  │              [确认]  [取消]                                        │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                   ┌──────────┐          ┌──────────┐
                   │   用户   │          │   用户   │
                   │   确认   │          │   取消   │
                   └────┬─────┘          └────┬─────┘
                        │                    │
                        ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 7: 引擎核心底座                                                    │
│                                                                         │
│  执行操作：                                                              │
│  1. 创建订单记录                                                         │
│  2. 预留库存（扣减可用库存）                                              │
│  3. 生成审计日志                                                          │
│  4. 发送通知（如有）                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              返回结果                                    │
│                                                                         │
│  {                                                                       │
│    "success": true,                                                    │
│    "order_id": "OR202604160001",                                        │
│    "customer": "伟业贸易公司",                                           │
│    "items": [{                                                          │
│      "product": "马克笔",                                                │
│      "quantity": 1000,                                                 │
│      "unit_price": 2.50,                                                │
│      "subtotal": 2500.00                                                │
│    }],                                                                   │
│    "total": 2500.00,                                                    │
│    "status": "confirmed",                                               │
│    "created_at": "2026-04-16T10:00:00Z"                                │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 各层详细交互

### 3.1 Layer 1: 多端接入适配层

**输入**：
```json
{
  "message": "给伟业贸易公司创建一个订单，订购1000个马克笔，单价2.5元。",
  "session_id": "sess_abc123",
  "user_id": "user_001",
  "channel": "mini_program"
}
```

**输出**：
```json
{
  "request_id": "req_uuid",
  "original_message": "给伟业贸易公司创建一个订单，订购1000个马克笔，单价2.5元。",
  "session_id": "sess_abc123",
  "user_id": "user_001",
  "timestamp": "2026-04-16T10:00:00Z",
  "metadata": {
    "channel": "mini_program",
    "client_version": "1.0.0"
  }
}
```

### 3.2 Layer 2: 统一API网关

**校验项**：
| 校验项 | 说明 |
|--------|------|
| Token有效性 | JWT解析，验证签名和过期时间 |
| 用户状态 | 用户是否被禁用 |
| 请求限流 | 是否超出QPS限制 |
| 参数完整性 | 基本参数是否存在 |

**失败响应**：
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Token已过期，请重新登录"
  }
}
```

### 3.3 Layer 3: 多Agent协同决策域

#### 3.3.1 主Agent意图拆解

```json
{
  "intention": "CREATE_ORDER",
  "confidence": 0.95,
  "entities": {
    "customer_name": "伟业贸易公司",
    "product_name": "马克笔",
    "quantity": 1000,
    "unit_price": 2.5
  },
  "proposed_operation": "order.create",
  "proposed_params": {
    "customer_id": null,
    "product_id": null,
    "quantity": 1000,
    "unit_price": 2.5
  }
}
```

#### 3.3.2 子Agent1业务规则校验

```json
{
  "agent": "sub_agent_1",
  "validation_type": "business_rule",
  "checks": [
    {
      "rule": "customer.exists_validation",
      "input": { "customer_name": "伟业贸易公司" },
      "result": "pass",
      "resolved_customer_id": "C0012345678"
    },
    {
      "rule": "inventory.reserve_validation",
      "input": { "product_name": "马克笔", "quantity": 1000 },
      "result": "pass",
      "available_stock": 5000
    },
    {
      "rule": "order.price_validation",
      "input": { "unit_price": 2.5, "product_id": "P0001" },
      "result": "pass",
      "min_price": 2.0,
      "max_price": 3.0
    }
  ],
  "decision": "APPROVE",
  "agreed_operation": "order.create",
  "agreed_params": {
    "customer_id": "C0012345678",
    "product_id": "P0001",
    "quantity": 1000,
    "unit_price": 2.5
  }
}
```

#### 3.3.3 子Agent2安全权限校验

```json
{
  "agent": "sub_agent_2",
  "validation_type": "security_permission",
  "checks": [
    {
      "rule": "user.permission_check",
      "input": { "user_id": "user_001", "operation": "order.create" },
      "result": "pass",
      "user_role": "sales_manager"
    },
    {
      "rule": "data.access_check",
      "input": { "user_id": "user_001", "customer_id": "C0012345678" },
      "result": "pass",
      "access_level": "full"
    },
    {
      "rule": "operation.risk_check",
      "input": { "operation": "order.create", "amount": 2500 },
      "result": "pass",
      "risk_level": "low"
    }
  ],
  "decision": "APPROVE",
  "requires_approval": true,
  "approval_type": "user_confirmation"
}
```

#### 3.3.4 投票决策

```json
{
  "vote_id": "vote_uuid",
  "proposals": [
    { "agent": "main", "decision": "APPROVE" },
    { "agent": "sub_1", "decision": "APPROVE" },
    { "agent": "sub_2", "decision": "APPROVE" }
  ],
  "result": "APPROVED",
  "agreed_params": {
    "customer_id": "C0012345678",
    "product_id": "P0001",
    "quantity": 1000,
    "unit_price": 2.5
  }
}
```

### 3.4 Layer 4: OpenClaw调度层

```json
{
  "tool_call": {
    "tool": "order.create",
    "params": {
      "customer_id": "C0012345678",
      "product_id": "P0001",
      "quantity": 1000,
      "unit_price": 2.5
    }
  },
  "approval": {
    "required": true,
    "type": "user_confirmation",
    "pending": true,
    "timeout_hours": 24
  }
}
```

### 3.5 Layer 5: MCP工具白名单层

```json
{
  "tool_definition": {
    "name": "order_create",
    "parameters": {
      "customer_id": {
        "type": "string",
        "required": true,
        "pattern": "^C\\d{10}$"
      },
      "product_id": {
        "type": "string",
        "required": true,
        "pattern": "^P\\d{10}$"
      },
      "quantity": {
        "type": "integer",
        "required": true,
        "min": 1,
        "max": 100000
      },
      "unit_price": {
        "type": "decimal",
        "required": true,
        "min": 0.01,
        "max": 999999.99
      }
    }
  },
  "validation_result": {
    "passed": true,
    "validated_params": {
      "customer_id": "C0012345678",
      "product_id": "P0001",
      "quantity": 1000,
      "unit_price": 2.5
    }
  }
}
```

### 3.6 Layer 6: 业务规则中枢

```json
{
  "rule_executions": [
    {
      "rule": "customer.exists_validation",
      "result": "pass",
      "details": { "customer_id": "C0012345678", "status": "active" }
    },
    {
      "rule": "order.price_validation",
      "result": "pass",
      "details": { "within_range": true }
    },
    {
      "rule": "inventory.reserve_validation",
      "result": "pass",
      "details": { "available": 5000, "reserved": 1000, "remaining": 4000 }
    }
  ],
  "final_result": "pass",
  "execution_time_ms": 45
}
```

### 3.7 Layer 7: 引擎核心底座

```json
{
  "database_operations": [
    {
      "operation": "INSERT",
      "entity": "orders",
      "data": {
        "order_id": "OR202604160001",
        "customer_id": "C0012345678",
        "status": "confirmed",
        "total_amount": 2500.00,
        "created_by": "user_001",
        "created_at": "2026-04-16T10:00:00Z"
      }
    },
    {
      "operation": "UPDATE",
      "entity": "inventory",
      "data": {
        "product_id": "P0001",
        "available_quantity": 4000,
        "reserved_quantity": 1000
      }
    }
  ],
  "audit_log": {
    "log_id": "audit_uuid",
    "operation": "order.create",
    "user_id": "user_001",
    "result": "success",
    "timestamp": "2026-04-16T10:00:00Z"
  }
}
```

---

## 4. 异常流程处理

### 4.1 客户不存在

```
用户输入
    │
    ▼
主Agent拆解 → 客户名="伟业贸易公司"
    │
    ▼
子Agent1校验 → customer.exists_validation → FAIL: 客户不存在
    │
    ▼
投票否决 → 返回："未找到客户'伟业贸易公司'，请检查客户名称或先创建客户"
```

### 4.2 库存不足

```
用户输入
    │
    ▼
主Agent拆解 → 商品=马克笔, 数量=1000
    │
    ▼
子Agent1校验 → inventory.reserve_validation → FAIL: 库存不足(仅剩500)
    │
    ▼
投票否决 → 返回："马克笔库存不足，当前可用500个，请减少数量或等待补货"
```

### 4.3 价格超出范围

```
用户输入
    │
    ▼
主Agent拆解 → 单价=2.5元
    │
    ▼
子Agent1校验 → order.price_validation → FAIL: 单价低于最低价2.0元
    │
    ▼
投票否决 → 返回："单价2.5元低于允许的最低价2.0元，请调整价格"
```

### 4.4 用户取消确认

```
人工确认弹窗
    │
    ▼
用户点击"取消"
    │
    ▼
返回结果：{ success: false, message: "操作已取消" }
```

---

## 5. 性能指标

### 5.1 各层延迟

| 层级 | 典型延迟 | P99延迟 |
|------|----------|---------|
| Layer 1-2 (接入+网关) | 10-20ms | 50ms |
| Layer 3 (多Agent校验) | 2000-5000ms | 8000ms |
| Layer 4 (OpenClaw调度) | 50-100ms | 200ms |
| Layer 5 (MCP校验) | 5-10ms | 20ms |
| Layer 6 (业务规则) | 50-200ms | 500ms |
| Layer 7 (数据库) | 20-50ms | 100ms |
| **总计（不含人工确认）** | **约2.5-5.5秒** | **约9秒** |

### 5.2 人工确认等待时间

人工确认不计入系统延迟，但需要考虑：
- 用户平均响应时间：30秒-5分钟
- 超时设置：24小时

---

## 6. 结论

核心请求全流程通过七层架构实现了：

1. **请求标准化**：多端适配，统一入口
2. **意图理解**：主Agent准确理解用户意图
3. **多Agent校验**：从业务和安全双视角验证
4. **工具调用**：MCP标准化工具定义
5. **参数校验**：格式和范围检查
6. **业务规则**：最终业务逻辑校验
7. **人工确认**：用户最终决策权
8. **执行审计**：全链路日志记录

每层都有明确的职责和失败处理，确保系统安全可控。

---

## 相关文档

- [14-unified-architecture.md](14-unified-architecture.md) — 统一架构框架（裁决版，权威；本文为历史方案，不得据此实现）
- [01-multi-agent-design.md](01-multi-agent-design.md) — Multi-Agent 协同决策系统设计
- [05-four-layer-safety.md](05-four-layer-safety.md) — 六重防护机制详解（历史方案）
- [06-system-architecture.md](06-system-architecture.md) — 整体技术架构设计
- [12-hook-system-design.md](12-hook-system-design.md) — Hook 系统详细设计
- [13-trusted-execution-architecture.md](13-trusted-execution-architecture.md) — 可信执行架构详细设计（当前方案）

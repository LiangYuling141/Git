# MCP 工具白名单体系设计

> **架构演进说明**：本文档描述基础白名单机制；当前特制 MCP 工具链（查询 / 预览 / 确认 / 执行）见 [13-trusted-execution-architecture.md](13-trusted-execution-architecture.md)。

> 本文档详细描述 MCP（Model Context Protocol）工具白名单体系的设计方案，实现 AI 与业务逻辑的彻底隔离。

---

## 1. 背景与设计原则

### 1.1 核心问题

AI Agent 可能产生幻觉，导致：
- 生成错误的参数值
- 调用不存在的操作
- 越权访问数据

### 1.2 解决思路

采用 MCP 协议，将 AI 可调用的能力严格限制在白名单内，实现"先有规则后有工具，无规则的工具绝对不允许注册"。

### 1.3 核心设计原则

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP 白名单体系三原则                       │
├─────────────────────────────────────────────────────────────┤
│  1. 工具与业务规则一对一映射                                 │
│     → 每个MCP工具严格对应一个固定业务规则                     │
│                                                             │
│  2. 参数前置强校验                                           │
│     → 不符合规则的参数直接拦截                               │
│                                                             │
│  3. 白名单管控                                               │
│     → AI仅能调用已注册的工具，无法调用未授权服务              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. MCP 工具设计

### 2.1 工具分类

| 类别 | 说明 | 权限要求 |
|------|------|----------|
| **只读类** | 查询类操作，校验通过后可直接调用 | 低风险 |
| **写入类** | 创建、更新、删除类操作，必须人工确认 | 高风险 |

### 2.2 工具定义模板

```json
{
  "name": "customer_query",
  "description": "查询客户信息",
  "category": "readonly",
  "mapped_business_rule": "customer.exists_validation",
  "parameters": {
    "customer_id": {
      "type": "string",
      "required": true,
      "pattern": "^C\\d{10}$",
      "description": "客户ID，格式：C+10位数字"
    }
  },
  "response": {
    "type": "object",
    "properties": {
      "customer_id": { "type": "string" },
      "name": { "type": "string" },
      "status": { "type": "string", "enum": ["active", "inactive"] }
    }
  },
  "permissions": ["customer:read"]
}
```

### 2.3 核心工具清单（MVP阶段）

#### 只读类工具

| 工具名称 | 对应业务规则 | 说明 |
|----------|--------------|------|
| `customer_query` | customer.exists_validation | 查询客户信息 |
| `customer_list` | customer.list_validation | 客户列表查询 |
| `order_query` | order.exists_validation | 查询订单信息 |
| `order_list` | order.list_validation | 订单列表查询 |
| `inventory_query` | inventory.check_validation | 库存查询 |
| `inventory_reserve_check` | inventory.reserve_validation | 预留检查 |

#### 写入类工具

| 工具名称 | 对应业务规则 | 说明 |
|----------|--------------|------|
| `customer_create` | customer.create_validation | 创建客户 |
| `order_create` | order.create_validation | 创建订单 |
| `order_update` | order.update_validation | 更新订单 |
| `inventory_reserve` | inventory.reserve_execute | 预留库存 |
| `inventory_release` | inventory.release_execute | 释放库存 |

---

## 3. 参数校验机制

### 3.1 校验层级

```
┌─────────────────────────────────────────────────────────────┐
│                    参数校验三层防御                           │
├─────────────────────────────────────────────────────────────┤
│  第1层：MCP工具定义校验                                       │
│  → 类型、格式、必填项、枚举值                                 │
│         │                                                   │
│         ▼                                                   │
│  第2层：业务规则校验                                         │
│  → 业务逻辑有效性（如客户状态、库存数量范围）                   │
│         │                                                   │
│         ▼                                                   │
│  第3层：安全合规校验                                         │
│  → 权限、敏感数据、数据脱敏                                   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 校验失败处理

| 校验层级 | 失败响应 | 后续动作 |
|----------|----------|----------|
| MCP工具定义校验 | 400 Bad Request | 返回具体字段错误 |
| 业务规则校验 | 422 Unprocessable Entity | 返回违反的规则 |
| 安全合规校验 | 403 Forbidden | 返回权限问题 |

### 3.3 校验示例

```json
// 请求：查询客户
{
  "tool": "customer_query",
  "parameters": {
    "customer_id": "C12345"  // 格式错误，应该是C+10位数字
  }
}

// 响应：校验失败
{
  "success": false,
  "error": {
    "code": "INVALID_PARAMETER",
    "layer": "mcp_definition",
    "field": "customer_id",
    "message": "customer_id格式错误，应为C+10位数字",
    "received": "C12345"
  }
}
```

---

## 4. 白名单管控

### 4.1 注册机制

```typescript
// MCP工具注册表
class ToolRegistry {
  private tools: Map<string, MCPTool> = new Map();

  register(tool: MCPTool) {
    // 1. 检查是否已有同名工具
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }

    // 2. 验证工具定义完整性
    this.validateToolDefinition(tool);

    // 3. 验证映射的业务规则存在
    this.validateBusinessRuleExists(tool.mapped_business_rule);

    // 4. 注册到白名单
    this.tools.set(tool.name, tool);
  }

  // AI只能获取白名单内的工具列表
  getAllowedTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }
}
```

### 4.2 权限分级

```
┌─────────────────────────────────────────────────────────────┐
│                    工具权限分级                               │
├─────────────────────────────────────────────────────────────┤
│  L1 公开工具（无需登录）                                       │
│  → 无敏感操作，仅供浏览                                       │
│                                                             │
│  L2 注册工具（需登录）                                        │
│  → 只读类操作，需要有效会话                                   │
│                                                             │
│  L3 写入工具（需确认）                                        │
│  → 写入类操作，需要人工确认                                   │
│                                                             │
│  L4 管理工具（需权限）                                        │
│  → 系统管理操作，需要特定权限角色                              │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 动态权限控制

```yaml
# 工具权限配置示例
tools:
  customer_query:
    level: 2
    requires_auth: true
    rate_limit:
      requests_per_minute: 60

  customer_create:
    level: 3
    requires_auth: true
    requires_approval: true  # 写入类需要人工确认
    rate_limit:
      requests_per_minute: 10

  system_config_update:
    level: 4
    requires_auth: true
    requires_role: ["admin"]
    requires_approval: true
```

---

## 5. 与业务引擎的集成

### 5.1 工具 → 业务规则映射

```json
{
  "tool_to_rule_mapping": {
    "customer_query": "customer.exists_validation",
    "customer_create": "customer.create_validation",
    "order_create": "order.create_validation",
    "inventory_reserve": "inventory.reserve_execute"
  }
}
```

### 5.2 调用流程

```
AI决策调用工具
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  1. MCP工具定义校验                                          │
│     → 参数类型、格式、必填项                                   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  2. 白名单检查                                                │
│     → 工具是否在白名单内                                      │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  3. 权限检查                                                 │
│     → 用户是否有权限调用此工具                                 │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  4. 业务规则校验（通过业务引擎）                               │
│     → 业务逻辑有效性                                         │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  5. 执行并返回结果                                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 工具扩展机制

### 6.1 新增工具流程

```
业务方提出新需求
    │
    ▼
需求分析：是否需要新工具？
    │
    ├─ 否 → 映射到现有工具
    │
    └─ 是 → 继续
            │
            ▼
        定义业务规则
            │
            ▼
        开发MCP工具
            │
            ▼
        注册到白名单
            │
            ▼
        更新Agent提示词
            │
            ▼
        测试验证
            │
            ▼
        上线
```

### 6.2 工具版本管理

```json
{
  "tool_versions": {
    "customer_query": {
      "current": "1.2.0",
      "compatible_since": "1.0.0",
      "changelog": [
        "1.2.0: 增加status筛选参数",
        "1.1.0: 增加分页支持",
        "1.0.0: 初始版本"
      ]
    }
  }
}
```

---

## 7. 监控与告警

### 7.1 监控指标

| 指标 | 说明 | 告警阈值 |
|------|------|----------|
| tool_call_total | 工具调用次数 | - |
| tool_call_success_rate | 调用成功率 | < 95% |
| tool_call_latency_p95 | P95延迟 | > 2s |
| unauthorized_attempts | 未授权尝试次数 | > 10/分钟 |
| invalid_params_rate | 参数错误率 | > 20% |

### 7.2 审计日志

每个工具调用必须记录：

```json
{
  "log_id": "uuid",
  "timestamp": "2026-04-16T10:00:00Z",
  "tool_name": "customer_query",
  "parameters": { "customer_id": "C0000000001" },
  "user_id": "user_123",
  "result": "success",
  "latency_ms": 45,
  "ip_address": "x.x.x.x"
}
```

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 新业务场景无法映射 | 中 | 高 | 预留扩展机制，快速迭代 |
| 参数校验规则不完整 | 中 | 高 | 上线前充分测试，持续补充 |
| AI绕过白名单调用 | 低 | 极高 | 框架层面强制校验，无旁路 |
| 白名单配置错误 | 低 | 高 | 审批流程，测试验证 |

---

## 9. 结论

MCP 工具白名单体系是 AI 与业务逻辑隔离的关键机制。通过：

1. **一对一映射**：工具即业务规则，无冗余
2. **三层校验**：定义层、规则层、合规层
3. **白名单管控**：AI只能调用已注册工具
4. **分级权限**：读写分离，确认机制

这套机制可以过滤大部分因 AI 幻觉导致的无效请求，是六重防护体系的重要一环。

---

## 15. 与 Hook 系统联动

### 15.1 联动架构

MCP 白名单与 Hook 系统形成**分层防护**：

```
Stop Hooks（危险模式检测）
    │
    ▼
MCP 白名单校验（工具 + 参数）
    │
    ▼
Tool Hooks（参数深度验证）
    │
    ▼
业务引擎执行
```

### 15.2 Tool Hooks 增强

MCP 白名单只验证**工具是否存在**和**参数格式**，Tool Hooks 提供**深度验证**：

| 验证层 | 验证内容 | 示例 |
|--------|----------|------|
| MCP 白名单 | 工具是否存在、参数类型 | `customer.create` 存在，参数是对象 |
| Tool Hooks | 参数业务含义 | `phone` 符合正则、`amount` 在范围内 |

### 15.3 实现示例

```typescript
// ToolParameterValidationHook
const toolParameterValidationHook = {
  name: 'tool_parameter_validation',
  type: 'pre_tool',
  async execute(context: HookContext): Promise<HookResult> {
    const { toolCall } = context

    // MCP 已验证：工具存在、参数类型正确
    // Tool Hook 验证：参数业务含义

    const rules = getRulesForTool(toolCall.toolName)

    // 深度验证
    for (const [field, rule] of Object.entries(rules.validation)) {
      if (!rule.validate(toolCall.parameters[field])) {
        return {
          status: 'block',
          message: `参数 ${field} 验证失败: ${rule.message}`
        }
      }
    }

    return { status: 'allow' }
  }
}
```

---

## 相关文档

- [14-unified-architecture.md](14-unified-architecture.md) — 统一架构框架（裁决版，权威）
- [01-multi-agent-design.md](01-multi-agent-design.md) — Multi-Agent 协同决策系统设计
- [04-business-engine.md](04-business-engine.md) — 统一业务引擎设计
- [05-four-layer-safety.md](05-four-layer-safety.md) — 六重防护机制详解（历史方案）
- [12-hook-system-design.md](12-hook-system-design.md) — Hook 系统详细设计
- [13-trusted-execution-architecture.md](13-trusted-execution-architecture.md) — 可信执行架构详细设计（当前方案）

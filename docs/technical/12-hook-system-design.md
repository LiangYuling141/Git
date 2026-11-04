# Hook 系统设计

> **⚠️ 已被裁决**：Hook 不再是独立的横切安全层。Hook 被收编进 **L5 业务执行层**，只能作为契约 `Check` 的实现机制运行在可信域内。
> 运行在 Agent 进程中的 Hook **不计入安全边界**——Agent 可被替换或攻破，其进程内的拦截不可信。
> 权威定义见 [14-unified-architecture.md](14-unified-architecture.md) §9「能力归属矩阵」。
>
> 本文档中的「多 Agent 投票保持不变」「Stop Hooks 拦截后要求 AI 重新生成」等表述已失效。凡与 14 号冲突处一律以 14 号为准。

> 本文档设计一套 Hook 机制，用于在契约执行的关键节点进行拦截、验证和增强。Hook 运行于 MCP Server 内部，实现与契约 `Check` 的职责对齐。

---

## 1. 设计背景

### 1.1 为什么需要 Hook

现有的四层防护体系存在以下局限：

| 局限 | 说明 | 影响 |
|------|------|------|
| **时机单一** | 仅在投票后、执行前确认 | 无法在过程中干预 |
| **粒度粗** | 以"操作"为最小单位 | 无法检测操作内的危险模式 |
| **静态** | 配置固定，无法运行时调整 | 无法适应动态风险 |
| **无反馈** | 拦截后无法让 AI 自我修正 | 只能拒绝，无法引导 |

Hook 机制解决以上问题，实现：
- **细粒度控制**：在 token 级检测危险模式
- **多时机拦截**：执行前、执行中、执行后均可干预
- **动态调整**：根据上下文启用/禁用不同 Hook
- **智能修正**：拦截后可让 AI 重新生成安全方案

### 1.2 Hook 与现有架构的关系

```
┌─────────────────────────────────────────────────────────────────┐
│                      Hook 在防护体系中的位置                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  用户输入                                                       │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  Pre-Processing Hooks                    │    │
│  │  → 输入清洗、恶意检测、频率控制                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    AI 处理（含投票）                      │    │
│  └─────────────────────────────────────────────────────────┘    │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   Stop Hooks                             │    │
│  │  → 执行前最终检查、危险模式检测                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   Tool Hooks                             │    │
│  │  → 工具调用前/后验证                                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                 Post-Execution Hooks                    │    │
│  │  → 结果验证、异常检测、通知                            │    │
│  └─────────────────────────────────────────────────────────┘    │
│      │                                                         │
│      ▼                                                         │
│  用户确认 → 执行                                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 架构设计

### 2.1 Hook 类型体系

```typescript
// Hook 类型定义
type HookType =
  | 'pre_processing'   // 输入处理
  | 'pre_agent'        // Agent 执行前
  | 'post_agent'       // Agent 执行后
  | 'stop'             // 执行前最终拦截
  | 'pre_tool'         // 工具调用前
  | 'post_tool'        // 工具调用后
  | 'post_execution'   // 执行后验证
  | 'on_error'         // 错误处理
```

### 2.2 Hook 执行阶段

```
┌─────────────────────────────────────────────────────────────────┐
│                       Hook 执行时间线                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  T1        T2        T3        T4        T5        T6        T7 │
│   │         │         │         │         │         │         │   │
│   ▼         ▼         ▼         ▼         ▼         ▼         ▼   │
│  ┌────┐   ┌────┐   ┌────┐   ┌────┐   ┌────┐   ┌────┐   ┌────┐  │
│  │Pre │   │Pre │   │Stop│   │Pre │   │Post│   │Post│   │Err │  │
│  │Proc│   │Agnt│   │Hook│   │Tool│   │Tool│   │Exec│   │Hook│  │
│  └────┘   └────┘   └────┘   └────┘   └────┘   └────┘   └────┘  │
│                                                                  │
│  T1: Pre-Processing Hooks (用户输入清洗)                        │
│  T2: Pre-Agent Hooks (投票前)                                   │
│  T3: Stop Hooks (最终拦截点)                                    │
│  T4: Pre-Tool Hooks (工具调用前)                                │
│  T5: Post-Tool Hooks (工具调用后)                               │
│  T6: Post-Execution Hooks (执行后验证)                          │
│  T7: Error Hooks (错误处理)                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Hook 接口定义

```typescript
// Hook 接口
interface Hook {
  // 唯一标识
  name: string

  // Hook 类型
  type: HookType

  // 执行优先级（数字越小越先执行）
  priority: number

  // 是否默认启用
  enabledByDefault: boolean

  // 执行条件（可选）
  condition?: (context: HookContext) => boolean | Promise<boolean>

  // 主执行方法
  execute(context: HookContext): HookResult | Promise<HookResult>
}

// Hook 执行结果
interface HookResult {
  // 状态
  status: 'allow' | 'block' | 'warn' | 'modify'

  // 阻止时返回的消息
  message?: string

  // 警告消息（不阻止，但记录）
  warnings?: string[]

  // 拦截时是否让 AI 重新生成
  allowRetry: boolean

  // 修改后的数据（用于 modify 模式）
  modifiedData?: unknown
}

// Hook 上下文
interface HookContext {
  // 当前阶段
  phase: HookType

  // 用户输入
  userInput?: string

  // AI 输出/方案
  aiOutput?: string

  // 解析后的操作
  operation?: Operation

  // 风险等级
  riskLevel?: 'L0' | 'L1' | 'L2'

  // 客户信息
  customer?: Customer

  // 会话信息
  session: Session

  // 工具调用信息
  toolCall?: ToolCall

  // 自定义数据
  metadata: Record<string, unknown>
}
```

---

## 3. 内置 Hook 实现

### 3.1 Pre-Processing Hooks

#### 3.1.1 InputSanitizationHook

清理用户输入中的恶意内容。

```typescript
class InputSanitizationHook implements Hook {
  name = 'input_sanitization'
  type = 'pre_processing'
  priority = 100
  enabledByDefault = true

  execute(context: HookContext): HookResult {
    const input = context.userInput
    if (!input) return { status: 'allow', allowRetry: false }

    // 检测 SQL 注入
    if (this.containsSqlInjection(input)) {
      return {
        status: 'block',
        message: '检测到可疑的 SQL 注入模式',
        allowRetry: true,
      }
    }

    // 检测命令注入
    if (this.containsCommandInjection(input)) {
      return {
        status: 'block',
        message: '检测到可疑的命令注入模式',
        allowRetry: true,
      }
    }

    // 检测 Prompt 注入
    if (this.containsPromptInjection(input)) {
      return {
        status: 'block',
        message: '检测到可疑的 Prompt 注入',
        allowRetry: true,
      }
    }

    // 清理特殊字符
    const sanitized = this.sanitize(input)
    if (sanitized !== input) {
      context.metadata.sanitizedInput = sanitized
      return {
        status: 'modify',
        modifiedData: { userInput: sanitized },
        allowRetry: false,
      }
    }

    return { status: 'allow', allowRetry: false }
  }

  private containsSqlInjection(input: string): boolean {
    const patterns = [
      /(\bunion\b.*\bselect\b)/i,
      /(\bdrop\b.*\btable\b)/i,
      /('|"|;|--|\/\*|\*\/)/,
      /(\bor\b.*=.*\bor\b)/i,
    ]
    return patterns.some(p => p.test(input))
  }

  private containsCommandInjection(input: string): boolean {
    const patterns = [
      /[;&|`$]/,                    // Shell 特殊字符
      /\$\(.*\)/,                   // 命令替换
      /`.*`/,                        // 反引号替换
    ]
    return patterns.some(p => p.test(input))
  }

  private containsPromptInjection(input: string): boolean {
    const patterns = [
      /(ignore|disregard|forget).*previous/i,
      /system.*:/i,
      /you are now/i,
      /\[\s*system\s*\]/i,
    ]
    return patterns.some(p => p.test(input))
  }

  private sanitize(input: string): string {
    return input
      .replace(/[\x00-\x1F\x7F]/g, '') // 移除控制字符
      .trim()
  }
}
```

#### 3.1.2 RateLimitHook

频率控制，防止滥用。

```typescript
class RateLimitHook implements Hook {
  name = 'rate_limit'
  type = 'pre_processing'
  priority = 90
  enabledByDefault = true

  // 频率限制配置
  private config = {
    maxRequestsPerMinute: 60,
    maxRequestsPerHour: 500,
    maxOperationsPerMinute: 10,
    maxOperationsPerHour: 100,
  }

  async execute(context: HookContext): Promise<HookResult> {
    const userId = context.session.userId

    // 检查请求频率
    const requestCount = await this.getRequestCount(userId, 'minute')
    if (requestCount >= this.config.maxRequestsPerMinute) {
      return {
        status: 'block',
        message: '请求过于频繁，请稍后再试',
        allowRetry: true,
      }
    }

    // 检查操作频率
    if (context.operation) {
      const opCount = await this.getOperationCount(
        userId,
        context.operation.type,
        'minute'
      )
      if (opCount >= this.config.maxOperationsPerMinute) {
        return {
          status: 'block',
          message: `${context.operation.type} 操作过于频繁`,
          allowRetry: true,
        }
      }
    }

    return { status: 'allow', allowRetry: false }
  }

  private async getRequestCount(userId: string, window: string): Promise<number> {
    // 实现计数逻辑
    return 0
  }
}
```

### 3.2 Stop Hooks

#### 3.2.1 DangerousPatternHook

检测危险操作模式，是最核心的拦截器。

```typescript
class DangerousPatternHook implements Hook {
  name = 'dangerous_pattern'
  type = 'stop'
  priority = 100
  enabledByDefault = true

  // 危险模式定义
  private patterns = {
    // 破坏性操作
    destructive: [
      { pattern: /rm\s+-rf/i, message: '检测到递归删除操作' },
      { pattern: /drop\s+(table|database)/i, message: '检测到删除表/数据库操作' },
      { pattern: /truncate\s+\w+/i, message: '检测到清空表操作' },
      { pattern: /delete\s+from\s+\w+\s*(;|$)/im, message: '检测到无条件的删除操作' },
      { pattern: /shutdown\s+/i, message: '检测到关闭系统命令' },
    ],

    // 权限提升
    privilegeEscalation: [
      { pattern: /chmod\s+777/i, message: '检测到极不安全的权限设置' },
      { pattern: /chown\s+\w+:\w+\s+\//i, message: '检测到修改根目录所有权' },
      { pattern: /sudo\s+without/i, message: '检测到尝试绕过 sudo' },
    ],

    // 数据泄露
    dataExfiltration: [
      { pattern: /\bexec\s*\(\s*\$_(GET|POST|REQUEST)/i, message: '检测到可疑的代码执行' },
      { pattern: /base64_decode\s*\(/i, message: '检测到 Base64 解码操作' },
      { pattern: /concat\s*\(.*from/i, message: '检测到可疑的数据拼接查询' },
    ],

    // 绕过安全机制
    bypass: [
      { pattern: /--\s*$/m, message: '检测到 SQL 注释注入' },
      { pattern: /\/\*.*\*\//m, message: '检测到块注释注入' },
      { pattern: /(\bor\b|')\s*1\s*=\s*1/i, message: '检测到永真条件注入' },
    ],
  }

  execute(context: HookContext): HookResult {
    const content = context.aiOutput || context.operation?.description || ''
    const warnings: string[] = []

    for (const [category, rules] of Object.entries(this.patterns)) {
      for (const rule of rules) {
        if (rule.pattern.test(content)) {
          // 危险操作直接阻止
          if (['destructive', 'privilegeEscalation'].includes(category)) {
            return {
              status: 'block',
              message: rule.message,
              allowRetry: true,
              warnings: [`危险类别: ${category}`],
            }
          }

          // 警告但不阻止
          warnings.push(`${rule.message} (${category})`)
        }
      }
    }

    if (warnings.length > 0) {
      return {
        status: 'warn',
        warnings,
        allowRetry: false,
      }
    }

    return { status: 'allow', allowRetry: false }
  }
}
```

#### 3.2.2 SensitiveDataExposureHook

检测敏感数据泄露。

```typescript
class SensitiveDataExposureHook implements Hook {
  name = 'sensitive_data_exposure'
  type = 'stop'
  priority = 95
  enabledByDefault = true

  // 敏感字段模式
  private sensitivePatterns = [
    { pattern: /\b\d{16,19}\b/, name: '银行卡号', category: 'financial' },
    { pattern: /\b\d{15,18}\b/, name: '身份证号', category: 'id' },
    { pattern: /password\s*[=:]\s*\S+/i, name: '密码明文', category: 'credential' },
    { pattern: /api[_-]?key\s*[=:]\s*\S+/i, name: 'API Key', category: 'credential' },
    { pattern: /secret\s*[=:]\s*\S+/i, name: '密钥', category: 'credential' },
    { pattern: /token\s*[=:]\s*\S+/i, name: 'Token', category: 'credential' },
  ]

  execute(context: HookContext): HookResult {
    const content = context.aiOutput || ''

    for (const rule of this.sensitivePatterns) {
      const matches = content.match(new RegExp(rule.pattern, 'g'))
      if (matches && matches.length > 0) {
        // 脱敏处理
        const masked = this.maskSensitiveData(content, rule.pattern)

        return {
          status: 'modify',
          message: `检测到 ${rule.name}，已自动脱敏`,
          modifiedData: { aiOutput: masked },
          allowRetry: false,
          warnings: [`类别: ${rule.category}`],
        }
      }
    }

    return { status: 'allow', allowRetry: false }
  }

  private maskSensitiveData(content: string, pattern: RegExp): string {
    return content.replace(new RegExp(pattern, 'gi'), (match) => {
      if (match.length <= 4) return '****'
      return match.slice(0, 2) + '*'.repeat(match.length - 4) + match.slice(-2)
    })
  }
}
```

#### 3.2.3 BusinessRuleViolationHook

业务规则违规检测。

```typescript
class BusinessRuleViolationHook implements Hook {
  name = 'business_rule_violation'
  type = 'stop'
  priority = 80
  enabledByDefault = true

  execute(context: HookContext): HookResult {
    const operation = context.operation
    if (!operation) return { status: 'allow', allowRetry: false }

    const violations: string[] = []

    // 规则1：信用额度调整需特殊确认
    if (this.isCreditLimitChange(operation)) {
      if (operation.amount > context.customer.creditLimit * 2) {
        violations.push('信用额度调整超过当前额度的 200%')
      }
      if (operation.amount > 500000) {
        violations.push('单次信用额度调整超过 50 万')
      }
    }

    // 规则2：价格修改需记录原因
    if (this.isPriceModification(operation)) {
      if (!operation.reason && context.riskLevel === 'L2') {
        violations.push('价格修改必须提供原因')
      }
    }

    // 规则3：高风险客户操作限制
    if (context.customer?.isHighRisk) {
      if (operation.type === 'delete') {
        violations.push('高风险客户不允许删除操作')
      }
      if (operation.amount > 10000) {
        violations.push('高风险客户单笔操作金额限制为 1 万')
      }
    }

    // 规则4：工作时间限制
    if (!this.isWorkingHours()) {
      if (operation.type === 'payment') {
        violations.push('非工作时间不允许收付款操作')
      }
    }

    if (violations.length > 0) {
      return {
        status: 'block',
        message: `业务规则违规:\n${violations.map(v => `- ${v}`).join('\n')}`,
        allowRetry: true,
        warnings: violations,
      }
    }

    return { status: 'allow', allowRetry: false }
  }

  private isCreditLimitChange(operation: Operation): boolean {
    return operation.entity === 'customer' &&
           operation.fields?.some(f => ['credit_limit', 'credit_line'].includes(f))
  }

  private isPriceModification(operation: Operation): boolean {
    return operation.entity === 'order' &&
           operation.fields?.some(f => ['price', 'discount', 'amount'].includes(f))
  }

  private isWorkingHours(): boolean {
    const hour = new Date().getHours()
    const day = new Date().getDay()
    return day >= 1 && day <= 5 && hour >= 9 && hour <= 18
  }
}
```

### 3.3 Tool Hooks

#### 3.3.1 ToolParameterValidationHook

工具参数深度验证。

```typescript
class ToolParameterValidationHook implements Hook {
  name = 'tool_parameter_validation'
  type = 'pre_tool'
  priority = 100
  enabledByDefault = true

  // 工具参数规则
  private toolRules = {
    'customer.create': {
      required: ['name', 'phone'],
      optional: ['email', 'address', 'tax_id'],
      validation: {
        phone: /^(1[3-9]\d{9})$/,
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        tax_id: /^[A-Z0-9]{15,20}$/i,
      },
    },
    'order.create': {
      required: ['customer_id', 'items', 'total_amount'],
      optional: ['discount', 'remark'],
      validation: {
        total_amount: (v: number) => v >= 0 && v <= 10000000,
        discount: (v: number) => v >= 0 && v <= 1,
      },
    },
    'payment.create': {
      required: ['order_id', 'amount', 'method'],
      optional: ['remark'],
      validation: {
        amount: (v: number) => v > 0 && v <= 5000000,
        method: ['cash', 'transfer', 'credit', 'wechat', 'alipay'],
      },
    },
  }

  execute(context: HookContext): HookResult {
    const toolCall = context.toolCall
    if (!toolCall) return { status: 'allow', allowRetry: false }

    const rules = this.toolRules[toolCall.toolName]
    if (!rules) return { status: 'allow', allowRetry: false }

    const errors: string[] = []
    const params = toolCall.parameters

    // 检查必填参数
    for (const field of rules.required) {
      if (params[field] === undefined || params[field] === null) {
        errors.push(`缺少必填参数: ${field}`)
      }
    }

    // 验证参数格式
    for (const [field, rule] of Object.entries(rules.validation || {})) {
      const value = params[field]
      if (value === undefined) continue

      if (typeof rule === 'function') {
        if (!rule(value)) {
          errors.push(`参数 ${field} 验证失败`)
        }
      } else if (rule instanceof RegExp) {
        if (!rule.test(String(value))) {
          errors.push(`参数 ${field} 格式错误`)
        }
      } else if (Array.isArray(rule)) {
        if (!rule.includes(value)) {
          errors.push(`参数 ${field} 必须是: ${rule.join(', ')}`)
        }
      }
    }

    if (errors.length > 0) {
      return {
        status: 'block',
        message: `工具参数验证失败:\n${errors.join('\n')}`,
        allowRetry: true,
      }
    }

    return { status: 'allow', allowRetry: false }
  }
}
```

### 3.4 Post-Execution Hooks

#### 3.4.1 ExecutionResultValidationHook

执行结果验证。

```typescript
class ExecutionResultValidationHook implements Hook {
  name = 'execution_result_validation'
  type = 'post_execution'
  priority = 100
  enabledByDefault = true

  execute(context: HookContext): HookResult {
    const result = context.metadata.executionResult
    if (!result) return { status: 'allow', allowRetry: false }

    // 检查是否有错误
    if (result.error) {
      return {
        status: 'block',
        message: `执行失败: ${result.error.message}`,
        allowRetry: false,
      }
    }

    // 验证返回数据合理性
    const validation = this.validateResultData(result.data)
    if (!validation.valid) {
      return {
        status: 'warn',
        message: `结果数据异常: ${validation.message}`,
        allowRetry: false,
        warnings: [`异常级别: ${validation.severity}`],
      }
    }

    // 检查数据量是否合理
    if (result.data && Array.isArray(result.data)) {
      if (result.data.length > 10000) {
        return {
          status: 'warn',
          message: '返回数据量过大，可能影响性能',
          allowRetry: false,
          warnings: [`数据量: ${result.data.length}`],
        }
      }
    }

    return { status: 'allow', allowRetry: false }
  }

  private validateResultData(data: unknown): { valid: boolean; message?: string; severity?: string } {
    // 实现数据验证逻辑
    return { valid: true }
  }
}
```

---

## 4. Hook 执行引擎

### 4.1 Hook 调度器

```typescript
class HookEngine {
  private hooks: Map<HookType, Hook[]> = new Map()

  // 注册 Hook
  register(hook: Hook): void {
    const hooks = this.hooks.get(hook.type) || []
    hooks.push(hook)
    hooks.sort((a, b) => a.priority - b.priority)
    this.hooks.set(hook.type, hooks)
  }

  // 执行指定类型的 Hooks
  async execute(type: HookType, context: HookContext): Promise<HookResult[]> {
    const hooks = this.hooks.get(type) || []

    // 过滤未启用且无条件的 Hook
    const enabledHooks = hooks.filter(h =>
      h.enabledByDefault ||
      context.session.enabledHooks?.includes(h.name)
    )

    const results: HookResult[] = []

    for (const hook of enabledHooks) {
      // 检查执行条件
      if (hook.condition && !await hook.condition(context)) {
        continue
      }

      try {
        const result = await hook.execute(context)

        // 阻止类结果立即返回
        if (result.status === 'block') {
          results.push(result)
          return results // 短路
        }

        results.push(result)

        // 如果是 modify，合并到 context
        if (result.status === 'modify' && result.modifiedData) {
          context.metadata = { ...context.metadata, ...result.modifiedData }
        }
      } catch (error) {
        // Hook 执行失败，记录但不影响流程
        console.error(`Hook ${hook.name} execution failed:`, error)
        results.push({
          status: 'warn',
          message: `Hook ${hook.name} 执行异常`,
          allowRetry: false,
        })
      }
    }

    return results
  }

  // 执行多个阶段的 Hooks
  async executePipeline(
    phases: HookType[],
    initialContext: HookContext
  ): Promise<{ context: HookContext; results: Map<HookType, HookResult[]> }> {
    const results = new Map<HookType, HookResult[]>()
    let context = initialContext

    for (const phase of phases) {
      const phaseResults = await this.execute(phase, context)

      // 如果有 block 结果，停止 pipeline
      if (phaseResults.some(r => r.status === 'block')) {
        results.set(phase, phaseResults)
        return { context, results }
      }

      results.set(phase, phaseResults)
    }

    return { context, results }
  }
}
```

### 4.2 Hook 执行流程

```
┌─────────────────────────────────────────────────────────────────┐
│                       Hook 执行流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  开始执行                                                        │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Pre-Processing Phase                                    │   │
│  │  1. InputSanitizationHook                              │   │
│  │  2. RateLimitHook                                       │   │
│  │  3. User意图分类Hook                                    │   │
│  │  → 任一 Block → 返回错误                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Agent Processing (多Agent投票)                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Pre-Agent Phase                                         │   │
│  │  1. RiskLevelConfirmHook                               │   │
│  │  → Block → 拒绝/要求确认                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Stop Phase (最终检查)                                    │   │
│  │  1. DangerousPatternHook                               │   │
│  │  2. SensitiveDataExposureHook                          │   │
│  │  3. BusinessRuleViolationHook                          │   │
│  │  → Block → 注入错误，要求 AI 重新生成                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│      │                                                         │
│      ▼                                                         │
│  用户确认                                                        │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Tool Execution                                          │   │
│  │  1. Pre-Tool: ToolParameterValidationHook              │   │
│  │  2. Tool 执行                                          │   │
│  │  3. Post-Tool: ResultValidationHook                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Post-Execution Phase                                    │   │
│  │  1. ExecutionResultValidationHook                      │   │
│  │  2. AuditLogHook                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│      │                                                         │
│      ▼                                                         │
│  执行完成                                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 与现有架构融合

### 5.1 融合架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    六重防护 + Hook 体系                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第1重：Pre-Processing Hooks                              │  │
│  │  输入清洗 → 频率控制 → 恶意检测                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第2重：多Agent投票（保持不变）                           │  │
│  │  主Agent + 子Agent1 + 子Agent2                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第3重：Pre-Agent Hooks                                  │  │
│  │  风险等级确认 → 权限检查 → 操作预检                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第4重：Stop Hooks（增强）                               │  │
│  │  危险模式检测 → 敏感数据检测 → 业务规则校验               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第5重：人工确认（保持不变）                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第6重：Tool Hooks + Post-Execution Hooks                 │  │
│  │  参数验证 → 结果验证 → 审计日志                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 配置示例

```yaml
# hook 配置
hooks:
  # 全局开关
  enabled: true

  # 各阶段开关
  phases:
    pre_processing: true
    pre_agent: true
    stop: true
    pre_tool: true
    post_tool: true
    post_execution: true

  # 内置 Hook 配置
  built_in:
    input_sanitization:
      enabled: true
      priority: 100

    rate_limit:
      enabled: true
      priority: 90
      config:
        max_requests_per_minute: 60
        max_operations_per_minute: 10

    dangerous_pattern:
      enabled: true
      priority: 100
      config:
        categories:
          destructive: block
          privilege_escalation: block
          data_exfiltration: warn
          bypass: warn

    sensitive_data_exposure:
      enabled: true
      priority: 95
      auto_mask: true

    business_rule_violation:
      enabled: true
      priority: 80

    tool_parameter_validation:
      enabled: true
      priority: 100

    execution_result_validation:
      enabled: true
      priority: 100

  # 自定义 Hook（用户可扩展）
  custom:
    - name: my_custom_hook
      type: stop
      priority: 50
      enabled: true
      config:
        patterns:
          - ...
```

---

## 6. 监控与调试

### 6.1 Hook 执行日志

```typescript
interface HookExecutionLog {
  id: string
  timestamp: Date
  hookName: string
  hookType: HookType
  phase: string
  status: 'allow' | 'block' | 'warn' | 'modify'
  duration: number // ms
  context: {
    userId: string
    operationType?: string
    riskLevel?: string
  }
  result: {
    message?: string
    warnings?: string[]
    modifiedData?: unknown
  }
  error?: string
}
```

### 6.2 调试接口

```typescript
// 调试端点
GET /api/debug/hooks
GET /api/debug/hooks/:name/execute
POST /api/debug/hooks/:name/test

// 测试 Hook
interface HookTestRequest {
  hookName: string
  testInput: {
    userInput?: string
    aiOutput?: string
    operation?: Operation
    riskLevel?: string
  }
}
```

---

## 7. 性能考虑

### 7.1 异步执行

```typescript
// 非关键 Hook 异步执行，不阻塞主流程
async executeNonBlocking(hooks: Hook[], context: HookContext): Promise<void> {
  await Promise.all(
    hooks
      .filter(h => h.type === 'post_execution')
      .map(h => h.execute(context))
  )
}
```

### 7.2 缓存结果

```typescript
// 相同条件的 Hook 结果可缓存
const hookResultCache = new LRUCache<string, HookResult>({
  max: 1000,
  ttl: 60000, // 1分钟
})

async executeWithCache(hook: Hook, context: HookContext): Promise<HookResult> {
  const cacheKey = this.generateCacheKey(hook.name, context)
  const cached = hookResultCache.get(cacheKey)
  if (cached) return cached

  const result = await hook.execute(context)
  hookResultCache.set(cacheKey, result)
  return result
}
```

---

## 8. 附录

### 8.1 Hook 优先级参考

| 优先级 | 范围 | 说明 |
|--------|------|------|
| 100 | 系统关键 | 必须首先执行，如输入清洗 |
| 90 | 频率控制 | 防止滥用 |
| 80 | 业务规则 | 业务逻辑检查 |
| 70 | 安全检测 | 危险模式、敏感数据 |
| 60 | 验证类 | 参数验证、结果验证 |
| 50 | 自定义 | 用户自定义 Hook |
| 10 | 审计类 | 日志、通知 |

### 8.2 相关文档

- [14-unified-architecture.md](14-unified-architecture.md) — 统一架构框架（裁决版，权威）
- [05-four-layer-safety.md](05-four-layer-safety.md) — 六重防护机制详解（历史方案）
- [08-risk-classification.md](08-risk-classification.md) — 风险分级体系
- [03-mcp-tool-whitelist.md](03-mcp-tool-whitelist.md) — MCP 工具白名单
- [13-trusted-execution-architecture.md](13-trusted-execution-architecture.md) — 可信执行架构详细设计（当前方案）

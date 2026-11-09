// =============================================================================
// Main Agent - Intent matching and orchestration with AI
// =============================================================================

import type { Operation, Session } from '@/types';
import { getHookEngine } from '@/hooks';
import type { HookContext } from '@/hooks/types';
import { votingDecisionMaker } from '@/voting';
import { riskAssessmentEngine } from '@/risk';
import { whitelistManager } from '@/white-list';
import { confirmationWorkflow } from '@/confirm';
import { businessEngine } from '@/engine';
import { llmClient, isDeepSeekConfigured, type LLMMessage } from '@/lib/ai/LLMClient';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'MainAgent');

const HOOK_PIPELINE = ['pre_processing', 'pre_agent', 'stop', 'pre_tool', 'post_execution'] as const;

const INTENT_SYSTEM_PROMPT = `You are an Intent Parser for the LyMatrix TEF reference implementation (CRM-ERP).
Your job is to understand user natural language input and convert it to structured operations.

 ENTITY TYPES:
- customer: Customer management (客户管理)
- order: Order management (订单管理)
- payment: Payment management (支付管理)

 OPERATION TYPES:
- query: Read/search operations (查询)
- create: Create new records (创建)
- update: Modify existing records (修改/更新)
- delete: Delete records (删除)

 EXTRACT FROM USER INPUT:
1. operation type (query/create/update/delete)
2. entity type (customer/order/payment)
3. any IDs mentioned (patterns: "ID是xxx", "id:xxx", "编号xxx")
4. any names mentioned (patterns: "名称是xxx", "叫xxx", "name是xxx")
5. any phone numbers mentioned (pattern: 1[3-9]\\d{9})
6. any amounts mentioned (pattern: xxx元, xxx块)
7. any other relevant data fields

Respond ONLY with JSON in this exact format:
{
  "type": "query|create|update|delete",
  "entity": "customer|order|payment",
  "id": "extracted_id_or_null",
  "data": {
    "name": "extracted_name_or_null",
    "phone": "extracted_phone_or_null",
    "amount": "extracted_amount_or_null",
    // any other extracted fields
  },
  "confidence": 0.0-1.0
}`;

export interface AgentResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  riskLevel?: string;
  requiresConfirmation?: boolean;
  confirmationId?: string;
}

export class MainAgent {
  async processUserInput(userInput: string, session: Session): Promise<AgentResponse> {
    // 1. Pre-Processing Hooks (input sanitization, rate limiting)
    const preProcessingContext = this.buildContext('pre_processing', userInput, session);
    const hookEngine = getHookEngine();

    const preResults = await hookEngine.execute('pre_processing', preProcessingContext);
    if (preResults.some((r) => r.status === 'block')) {
      const blockResult = preResults.find((r) => r.status === 'block');
      return {
        success: false,
        error: blockResult?.message || 'Input blocked by pre-processing hook',
      };
    }

    // 2. Parse intent and create operation (AI-powered with regex fallback)
    const operation = await this.parseIntentWithAI(userInput);

    // 3. Risk assessment
    const riskResult = riskAssessmentEngine.evaluateRiskLevel(operation, undefined, session);

    if (riskResult.decision === 'block') {
      return {
        success: false,
        error: `Blocked: ${riskResult.reasons.join('; ')}`,
        riskLevel: riskResult.riskLevel,
      };
    }

    // 4. Check whitelist fast track
    const skipVotes = await whitelistManager.getFastTrackSkipCount(session.userId);
    if (skipVotes > 0 && riskResult.riskLevel !== 'L0') {
      // Fast track - skip some voting
    }

    // 5. Voting decision
    const votingContext = this.buildContext('pre_agent', userInput, session, operation);
    votingContext.riskLevel = riskResult.riskLevel;

    const preAgentResults = await hookEngine.execute('pre_agent', votingContext);
    if (preAgentResults.some((r) => r.status === 'block')) {
      const blockResult = preAgentResults.find((r) => r.status === 'block');
      return {
        success: false,
        error: blockResult?.message || 'Blocked by pre-agent hook',
      };
    }

    // 6. Multi-agent voting
    const votingResult = await votingDecisionMaker.makeDecision(operation, session);

    if (votingResult.status === 'rejected') {
      return {
        success: false,
        error: votingResult.reason || 'Voting rejected',
        riskLevel: riskResult.riskLevel,
      };
    }

    // 7. Stop hooks (final check)
    const stopContext = this.buildContext('stop', userInput, session, operation);
    stopContext.riskLevel = riskResult.riskLevel;

    const stopResults = await hookEngine.execute('stop', stopContext);
    if (stopResults.some((r) => r.status === 'block')) {
      const blockResult = stopResults.find((r) => r.status === 'block');
      return {
        success: false,
        error: blockResult?.message || 'Blocked by stop hook',
        riskLevel: riskResult.riskLevel,
      };
    }

    // 8. Require confirmation for L2
    if (riskResult.requiresConfirmation) {
      const confirmationRequest = await confirmationWorkflow.createRequest(
        operation,
        riskResult.riskLevel,
        session
      );
      return {
        success: true,
        requiresConfirmation: true,
        confirmationId: confirmationRequest.id,
        riskLevel: riskResult.riskLevel,
      };
    }

    // 9. Execute operation
    const executionResult = await businessEngine.execute(operation, session);

    // 10. Post-execution hooks
    const postContext = this.buildContext('post_execution', userInput, session, operation);
    postContext.metadata.executionResult = executionResult;

    await hookEngine.execute('post_execution', postContext);

    if (!executionResult.success) {
      return {
        success: false,
        error: executionResult.error || 'Execution failed',
        riskLevel: riskResult.riskLevel,
      };
    }

    return {
      success: true,
      result: executionResult.data,
      riskLevel: riskResult.riskLevel,
    };
  }

  private buildContext(
    phase: HookContext['phase'],
    userInput: string | undefined,
    session: Session,
    operation?: Operation
  ): HookContext {
    return {
      phase,
      userInput,
      session,
      operation,
      metadata: {},
    };
  }

  private async parseIntentWithAI(userInput: string): Promise<Operation> {
    if (!isDeepSeekConfigured()) {
      logger.warn('DEEPSEEK_API_KEY not configured, using regex fallback');
      return this.parseIntentWithRegex(userInput);
    }

    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: INTENT_SYSTEM_PROMPT },
        { role: 'user', content: userInput },
      ];

      const response = await llmClient.chatWithRetry(
        {
          messages,
          temperature: 0.1,
          max_tokens: 500,
        },
        {
          maxRetries: 2,
          timeoutMs: 15000,
        }
      );

      const content = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content) as {
        type?: string;
        entity?: string;
        id?: string;
        data?: Record<string, unknown>;
        confidence?: number;
      };

      // Validate and normalize the response
      const validTypes = ['query', 'create', 'update', 'delete'];
      const validEntities = ['customer', 'order', 'payment'];

      const operationType = validTypes.includes(parsed.type || '') ? parsed.type as Operation['type'] : 'query';
      const entity = validEntities.includes(parsed.entity || '') ? parsed.entity as 'customer' | 'order' | 'payment' : 'unknown';

      logger.info(`AI parsed intent: ${operationType} ${entity} (confidence: ${parsed.confidence || 'N/A'})`);

      return {
        id: parsed.id || crypto.randomUUID(),
        type: operationType,
        entity,
        action: operationType,
        description: userInput,
        data: parsed.data,
      };
    } catch (error) {
      logger.error(`AI intent parsing failed, falling back to regex`, error as Error);
      return this.parseIntentWithRegex(userInput);
    }
  }

  private parseIntentWithRegex(userInput: string): Operation {
    const lowerInput = userInput.toLowerCase();

    // Determine operation type
    let type: 'query' | 'create' | 'update' | 'delete' = 'query';
    if (lowerInput.includes('创建') || lowerInput.includes('新增') || lowerInput.includes('create')) type = 'create';
    else if (lowerInput.includes('修改') || lowerInput.includes('更新') || lowerInput.includes('update')) type = 'update';
    else if (lowerInput.includes('删除') || lowerInput.includes('delete')) type = 'delete';

    // Determine entity
    let entity: 'customer' | 'order' | 'payment' | 'unknown' = 'unknown';
    if (lowerInput.includes('客户') || lowerInput.includes('customer')) entity = 'customer';
    else if (lowerInput.includes('订单') || lowerInput.includes('order')) entity = 'order';
    else if (lowerInput.includes('支付') || lowerInput.includes('payment')) entity = 'payment';

    // Extract id
    const idMatch = userInput.match(/ID[是为：:]\s*([^\s,，]+)/i)
                || userInput.match(/id[是为：:]\s*([^\s,，]+)/i)
                || userInput.match(/编号[是为：:]\s*([^\s,，]+)/i);
    const id = idMatch ? idMatch[1] : undefined;

    // Extract name
    const nameMatch = userInput.match(/名称[是为：:]\s*([^\s,，]+)/i)
                  || userInput.match(/叫\s*([^\s,，]+)/i)
                  || userInput.match(/name[是为：:]\s*([^\s,，]+)/i);
    const name = nameMatch ? nameMatch[1] : undefined;

    // Extract phone
    const phoneMatch = userInput.match(/电话[是为：:]\s*([^\s,，]+)/i)
                   || userInput.match(/手机[是为：:]\s*([^\s,，]+)/i)
                   || userInput.match(/1[3-9]\d{9}/);
    const phone = phoneMatch ? phoneMatch[1] : undefined;

    // Extract amount
    const amountMatch = userInput.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/)
                     || userInput.match(/总[金额:：:\s]*(\d+(?:\.\d+)?)/);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : undefined;

    // Build data object
    const data: Record<string, unknown> = {};
    if (name) data.name = name;
    if (phone) data.phone = phone;
    if (amount !== undefined) data.amount = amount;

    if (type === 'query' && name) data.name = name;

    return {
      id: id || crypto.randomUUID(),
      type,
      entity,
      action: type,
      description: userInput,
      data: Object.keys(data).length > 0 ? data : undefined,
    };
  }

  // Keep sync version for backward compatibility
  private parseIntent(userInput: string): Operation {
    // Synchronously call async version - this will use regex fallback for now
    // In production, processUserInput should await this
    const lowerInput = userInput.toLowerCase();

    let type: 'query' | 'create' | 'update' | 'delete' = 'query';
    if (lowerInput.includes('创建') || lowerInput.includes('新增') || lowerInput.includes('create')) type = 'create';
    else if (lowerInput.includes('修改') || lowerInput.includes('更新') || lowerInput.includes('update')) type = 'update';
    else if (lowerInput.includes('删除') || lowerInput.includes('delete')) type = 'delete';

    let entity: 'customer' | 'order' | 'payment' | 'unknown' = 'unknown';
    if (lowerInput.includes('客户') || lowerInput.includes('customer')) entity = 'customer';
    else if (lowerInput.includes('订单') || lowerInput.includes('order')) entity = 'order';
    else if (lowerInput.includes('支付') || lowerInput.includes('payment')) entity = 'payment';

    const idMatch = userInput.match(/ID[是为：:]\s*([^\s,，]+)/i)
                || userInput.match(/id[是为：:]\s*([^\s,，]+)/i)
                || userInput.match(/编号[是为：:]\s*([^\s,，]+)/i);
    const id = idMatch ? idMatch[1] : undefined;

    const nameMatch = userInput.match(/名称[是为：:]\s*([^\s,，]+)/i)
                  || userInput.match(/叫\s*([^\s,，]+)/i)
                  || userInput.match(/name[是为：:]\s*([^\s,，]+)/i);
    const name = nameMatch ? nameMatch[1] : undefined;

    const phoneMatch = userInput.match(/电话[是为：:]\s*([^\s,，]+)/i)
                   || userInput.match(/手机[是为：:]\s*([^\s,，]+)/i)
                   || userInput.match(/1[3-9]\d{9}/);
    const phone = phoneMatch ? phoneMatch[1] : undefined;

    const data: Record<string, unknown> = {};
    if (name) data.name = name;
    if (phone) data.phone = phone;

    return {
      id: id || crypto.randomUUID(),
      type,
      entity,
      action: type,
      description: userInput,
      data: Object.keys(data).length > 0 ? data : undefined,
    };
  }
}

export const mainAgent = new MainAgent();

// =============================================================================
// Main Agent - Intent matching and orchestration
// =============================================================================

import type { Operation, Session } from '@/types';
import { getHookEngine } from '@/hooks';
import type { HookContext } from '@/hooks/types';
import { votingDecisionMaker } from '@/voting';
import { riskAssessmentEngine } from '@/risk';
import { whitelistManager } from '@/white-list';
import { confirmationWorkflow } from '@/confirm';
import { businessEngine } from '@/engine';

const HOOK_PIPELINE = ['pre_processing', 'pre_agent', 'stop', 'pre_tool', 'post_execution'] as const;

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

    // 2. Parse intent and create operation
    const operation = this.parseIntent(userInput);

    // 3. Risk assessment
    const riskResult = riskAssessmentEngine.evaluateRiskLevel(operation, undefined, session);

    // 4. Check whitelist fast track
    const skipVotes = whitelistManager.getFastTrackSkipCount(session.userId);
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

  private parseIntent(userInput: string): Operation {
    // Simplified intent parsing
    // In production, this would use AI to parse the intent

    const lowerInput = userInput.toLowerCase();

    if (lowerInput.includes('查') || lowerInput.includes('query') || lowerInput.includes('search')) {
      return {
        id: crypto.randomUUID(),
        type: 'query',
        entity: 'unknown',
        action: 'query',
        description: userInput,
      };
    }

    if (lowerInput.includes('创建') || lowerInput.includes('新增') || lowerInput.includes('create')) {
      return {
        id: crypto.randomUUID(),
        type: 'create',
        entity: 'unknown',
        action: 'create',
        description: userInput,
      };
    }

    if (lowerInput.includes('修改') || lowerInput.includes('更新') || lowerInput.includes('update')) {
      return {
        id: crypto.randomUUID(),
        type: 'update',
        entity: 'unknown',
        action: 'update',
        description: userInput,
      };
    }

    if (lowerInput.includes('删除') || lowerInput.includes('delete')) {
      return {
        id: crypto.randomUUID(),
        type: 'delete',
        entity: 'unknown',
        action: 'delete',
        description: userInput,
      };
    }

    return {
      id: crypto.randomUUID(),
      type: 'query',
      entity: 'unknown',
      action: 'query',
      description: userInput,
    };
  }
}

export const mainAgent = new MainAgent();

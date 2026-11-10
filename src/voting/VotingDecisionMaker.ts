// =============================================================================
// Voting Decision Maker - L0/L1/L2 layered voting system
// =============================================================================

import type { Operation, RiskLevel, Session, VotingResult, AgentMessage } from '@/types';
import { loggerManager, LogCategory } from '@/lib/logger';

const logger = loggerManager.getLogger(LogCategory.SYSTEM, 'VotingDecisionMaker');

export interface VotingConfig {
  l0VotesRequired: 0;
  l1VotesRequired: 1; // Main agent only
  l2VotesRequired: 2; // Main + at least one sub-agent
}

export interface AgentVoter {
  role: 'main' | 'sub1' | 'sub2';
  vote(operation: Operation, context: Session): Promise<'approve' | 'reject'>;
  getReason(): string;
}

export type { ValidationResult } from '@/lib/ai/IAgentKernel';

export class VotingDecisionMaker {
  private config: VotingConfig = {
    l0VotesRequired: 0,
    l1VotesRequired: 1,
    l2VotesRequired: 2,
  };

  constructor(voters: AgentVoter[]) {
    this.voters = voters;
  }

  private voters: AgentVoter[];

  evaluateRiskLevel(operation: Operation, session: Session): RiskLevel {
    if (operation.type === 'query') {
      return 'L0';
    }

    if (operation.amount !== undefined) {
      if (operation.amount < 10000) {
        return 'L1';
      }
      return 'L2';
    }

    if (operation.type === 'delete') {
      return 'L2';
    }

    if (operation.type === 'create' || operation.type === 'update') {
      return 'L1';
    }

    return 'L1';
  }

  async makeDecision(
    operation: Operation,
    session: Session
  ): Promise<VotingResult> {
    const riskLevel = this.evaluateRiskLevel(operation, session);

    if (riskLevel === 'L0') {
      return {
        status: 'approved',
        votes: {},
      };
    }

    const mainVoter = this.voters.find((v) => v.role === 'main');
    const subVoters = this.voters.filter((v) => v.role !== 'main');

    // If no main voter, use sub-voters only for voting (mainAgent is coordinator, not voter)
    const votes: VotingResult['votes'] = {};

    if (!mainVoter && subVoters.length === 0) {
      return {
        status: 'rejected',
        votes: {},
        reason: 'No voting agents available',
      };
    }

    try {
      // For L1/L2, use sub-voters for voting when main voter is not available
      // MainAgent coordinates but doesn't vote on its own operations
      let approveCount = 0;
      let rejectCount = 0;
      const riskPoints: string[] = [];

      // Execute sub-voter votes in parallel
      const subVoterResults = await Promise.all(
        subVoters.map(async (voter) => {
          try {
            const votePromise = voter.vote(operation, session);
            const timeoutPromise = new Promise<'approve'>((_, reject) => {
              setTimeout(() => reject(new Error(`Sub-agent ${voter.role} timeout`)), 30000);
            });
            const subVote = await Promise.race([votePromise, timeoutPromise]);
            return { voter, vote: subVote as 'approve' | 'reject', error: null };
          } catch (error) {
            logger.error(`Sub-agent ${voter.role} voting failed`, error as Error);
            return { voter, vote: 'reject' as const, error };
          }
        })
      );

      for (const result of subVoterResults) {
        if (result.voter.role === 'sub1') {
          votes.subAgent1 = result.vote;
        } else if (result.voter.role === 'sub2') {
          votes.subAgent2 = result.vote;
        }

        if (result.vote === 'approve') {
          approveCount++;
        } else {
          rejectCount++;
          riskPoints.push(result.voter.getReason());
        }
      }

      // Determine approval based on risk level
      // L1: majority of sub-voters approve (at least 1 if only 1 voter)
      // L2: all sub-voters must approve (unanimous)
      const requiredApprovals = riskLevel === 'L2' ? subVoters.length : Math.ceil(subVoters.length / 2);

      if (approveCount >= requiredApprovals) {
        return {
          status: 'approved',
          votes,
        };
      }

      return {
        status: 'rejected',
        votes,
        reason: riskPoints.length > 0 ? riskPoints.join('; ') : 'Insufficient approvals',
        riskPoints,
      };
    } catch (error) {
      return {
        status: 'rejected',
        votes,
        reason: error instanceof Error ? error.message : 'Voting failed',
      };
    }
  }

  getVoters(): AgentVoter[] {
    return this.voters;
  }
}

// =============================================================================
// Voting System - Unified Exports
// =============================================================================

import { VotingDecisionMaker } from './VotingDecisionMaker';
import { subAgent1 } from '@/agents/SubAgent1';
import { subAgent2 } from '@/agents/SubAgent2';

export * from './VotingDecisionMaker';

export const votingDecisionMaker = new VotingDecisionMaker([subAgent1, subAgent2]);

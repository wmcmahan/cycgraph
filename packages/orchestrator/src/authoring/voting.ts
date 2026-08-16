/**
 * voting() — run several agents on the same task and aggregate their answers
 *
 * The voters come first: fanning out over them is what the node is. Aggregation
 * is `majority_vote` unless a strategy says otherwise, and `llm_judge` needs a
 * `judge` to arbitrate.
 *
 * Result keys are implied by the node type, so this spec takes no `writes`.
 *
 * @module authoring/voting
 */

import type { AgentValue } from './agent.js';
import { withOutputs, votingOutputs, type VotingOutputs } from './outputs.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Authoring spec for {@link voting}. */
export interface VotingSpec extends NodeCommon {
  /** How votes are aggregated. */
  strategy?: 'majority_vote' | 'weighted_vote' | 'llm_judge';
  /** Memory key each voter writes its vote to. */
  voteKey?: string;
  /** Votes required before a result counts. */
  quorum?: number;
  /** Arbitrating agent. Required by the `llm_judge` strategy. */
  judge?: AgentValue | string;
  /** Per-agent weights for `weighted_vote`. */
  weights?: Record<string, number>;
  /** Per-voter timeout in milliseconds. */
  taskTimeoutMs?: number;
}

/**
 * Author a `voting` node.
 *
 * @param voters - The agents that vote.
 * @param spec - Placement and aggregation settings.
 */
export function voting(voters: (AgentValue | string)[], spec: VotingSpec): NodeValue & VotingOutputs {
  const { strategy, voteKey, quorum, judge, weights, taskTimeoutMs, ...placement } = spec;

  return withOutputs({
    ...placement,
    type: 'voting' as const,
    votingConfig: {
      voterAgentIds: voters,
      ...(strategy !== undefined ? { strategy } : {}),
      ...(voteKey !== undefined ? { voteKey } : {}),
      ...(quorum !== undefined ? { quorum } : {}),
      ...(judge !== undefined ? { judgeAgentId: judge } : {}),
      ...(weights !== undefined ? { weights } : {}),
      ...(taskTimeoutMs !== undefined ? { taskTimeoutMs } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue, votingOutputs(spec.id));
}

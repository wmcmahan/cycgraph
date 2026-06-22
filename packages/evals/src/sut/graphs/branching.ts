/**
 * Branching Reference Graph
 *
 * Single agent prompted to emit a structured routing decision as JSON
 * (`{ branch, reason, action }`). Covers the `branching` / `conditional`
 * trajectory tag families — these goldens describe a decision-making
 * pattern rather than a multi-node graph, so we stay with a one-node
 * graph but constrain the prompt heavily.
 *
 * @module sut/graphs/branching
 */

import {
  InMemoryAgentRegistry,
  GraphSchema,
  WorkflowStateSchema,
} from '@cycgraph/orchestrator';
import type {
  Graph,
  WorkflowState,
  AgentRegistry,
} from '@cycgraph/orchestrator';

/** Options for the branching reference graph. */
export interface BranchingGraphOptions {
  /** Trajectory input — describes the branching predicate. */
  input: string;

  /** Model name (default: `'claude-sonnet-4-6'`). */
  model?: string;

  /** Provider name (default: `'anthropic'`). */
  provider?: string;

  /** Memory key the decision is written to (default: `'decision'`). */
  outputKey?: string;

  /** Max execution time in ms (default: `120 000`). */
  maxExecutionTimeMs?: number;
}

/** Constructed components for a branching SUT run. */
export interface BranchingGraphArtifacts {
  graph: Graph;
  initialState: WorkflowState;
  agentRegistry: AgentRegistry;
  outputKey: string;
}

const BRANCHING_PROMPT = [
  'You are a routing decision agent.',
  'Read the goal carefully — it describes a conditional ("if X, do A; otherwise B").',
  'Decide which branch applies. Be specific about why.',
  'Respond by saving a JSON object to memory with exactly these keys:',
  '  - branch: short identifier for the chosen path (e.g., "clean", "support", "auto-approve")',
  '  - reason: one-sentence justification grounded in the input',
  '  - action: one-sentence description of what was done as a result',
  'Do not include any other text in your response — only the saved decision.',
].join(' ');

/**
 * Build a single-agent branching graph for one trajectory.
 *
 * The agent's permissions allow it to read the goal/constraints and write
 * the structured decision to the configured `outputKey`.
 */
export function buildBranchingGraph(
  opts: BranchingGraphOptions,
): BranchingGraphArtifacts {
  const outputKey = opts.outputKey ?? 'decision';
  const registry = new InMemoryAgentRegistry();

  const agentId = registry.register({
    name: 'Branching Agent (SUT)',
    description: 'Emits a structured routing decision for a conditional goal',
    model: opts.model ?? 'claude-sonnet-4-6',
    provider: opts.provider ?? 'anthropic',
    systemPrompt: BRANCHING_PROMPT,
    temperature: 0.1,
    maxSteps: 4,
    tools: [{ type: 'builtin', name: 'save_to_memory' }],
    permissions: {
      readKeys: ['goal', 'constraints'],
      writeKeys: [outputKey],
    },
  });

  const graph = GraphSchema.parse({
    name: 'branching-sut',
    description: 'SUT reference graph: one agent emits a JSON routing decision',
    nodes: [
      {
        id: 'router',
        type: 'agent',
        agent_id: agentId,
        read_keys: ['goal', 'constraints'],
        write_keys: [outputKey],
        failure_policy: {
          max_retries: 2,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1_000,
          max_backoff_ms: 60_000,
        },
        requires_compensation: false,
      },
    ],
    edges: [],
    start_node: 'router',
    end_nodes: ['router'],
  });

  const initialState = WorkflowStateSchema.parse({
    workflow_id: graph.id,
    goal: opts.input,
    max_execution_time_ms: opts.maxExecutionTimeMs ?? 120_000,
  });

  return { graph, initialState, agentRegistry: registry, outputKey };
}

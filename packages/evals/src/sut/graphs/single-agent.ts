/**
 * Single-Agent Reference Graph
 *
 * Builds a minimal linear graph with one agent that writes its response to
 * a single memory key. Covers the `linear` / `basic` / `no-tools` /
 * `error/retry` / `budget` / `state` trajectory tag families.
 *
 * The agent's tool declarations come from the caller — pass
 * `tools: []` for no-tools trajectories, or
 * `tools: [{ type: 'mcp', serverId: 'mock', toolNames: ['web_search'] }]`
 * to let the mock resolver provide canned responses.
 *
 * @module sut/graphs/single-agent
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
  ToolSourceConfig,
} from '@cycgraph/orchestrator';

/** Options for the single-agent reference graph. */
export interface SingleAgentGraphOptions {
  /** Trajectory input — seeded as the workflow goal. */
  input: string;

  /**
   * Tools the agent declares. Pass an empty array for no-tools trajectories.
   * MCP-typed tools are resolved by the mock tool resolver during recording.
   */
  tools?: ToolSourceConfig[];

  /** Memory key the agent writes its response to (default: `'response'`). */
  outputKey?: string;

  /** Model name for the agent (default: `'claude-sonnet-4-6'`). */
  model?: string;

  /** Provider name (default: `'anthropic'`). */
  provider?: string;

  /**
   * System prompt for the agent. A reasonable default is provided that
   * instructs the agent to address the goal and write its answer to memory.
   */
  systemPrompt?: string;

  /** Max LLM steps the agent can take (default: `5`). */
  maxSteps?: number;

  /** Max execution time for the workflow in ms (default: `120 000`). */
  maxExecutionTimeMs?: number;
}

/** Constructed components for a single-agent SUT run. */
export interface SingleAgentGraphArtifacts {
  graph: Graph;
  initialState: WorkflowState;
  agentRegistry: AgentRegistry;
  outputKey: string;
}

const DEFAULT_PROMPT = [
  'You are a focused task assistant.',
  'Address the goal directly and concisely.',
  'When tools are available, use them only if they materially help.',
  'When you have an answer, save it to memory under the key provided in your write_keys.',
].join(' ');

/**
 * Build a single-agent graph, registry, and initial state for one trajectory.
 *
 * Returns everything the SUT needs to record: graph, initial state, agent
 * registry containing the lone agent, and the memory key from which output
 * will be extracted.
 */
export function buildSingleAgentGraph(
  opts: SingleAgentGraphOptions,
): SingleAgentGraphArtifacts {
  const outputKey = opts.outputKey ?? 'response';
  const tools = opts.tools ?? [];
  const registry = new InMemoryAgentRegistry();

  const agentId = registry.register({
    name: 'Single-Agent SUT',
    description: 'Generic agent for single-node trajectory recording',
    model: opts.model ?? 'claude-sonnet-4-6',
    provider: opts.provider ?? 'anthropic',
    systemPrompt: opts.systemPrompt ?? DEFAULT_PROMPT,
    temperature: 0.2,
    maxSteps: opts.maxSteps ?? 5,
    tools,
    permissions: {
      readKeys: ['goal', 'constraints'],
      writeKeys: [outputKey],
    },
  });

  const graph = GraphSchema.parse({
    name: 'single-agent-sut',
    description: 'SUT reference graph: one agent → one memory key',
    nodes: [
      {
        id: 'agent',
        type: 'agent',
        agent_id: agentId,
        read_keys: ['goal', 'constraints'],
        write_keys: [outputKey],
        failure_policy: {
          max_retries: 2,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60_000,
        },
        requires_compensation: false,
      },
    ],
    edges: [],
    start_node: 'agent',
    end_nodes: ['agent'],
  });

  const initialState = WorkflowStateSchema.parse({
    workflow_id: graph.id,
    goal: opts.input,
    max_execution_time_ms: opts.maxExecutionTimeMs ?? 120_000,
  });

  return { graph, initialState, agentRegistry: registry, outputKey };
}

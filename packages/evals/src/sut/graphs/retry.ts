/**
 * Retry Reference Graph
 *
 * Single agent equipped with a flaky tool that fails a configurable number
 * of times before succeeding. Used to record `error` / `retry` trajectory
 * families where the golden describes how the agent narrates handling an
 * unreliable resource.
 *
 * Failure mode is driven by the caller via the `flakyTool` factory in
 * `tools/retry-fixtures.ts` so the recording script can produce the same
 * canned failures across all retry trajectories.
 *
 * @module sut/graphs/retry
 */

import {
  InMemoryAgentRegistry,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';
import type {
  Graph,
  WorkflowState,
  AgentRegistry,
  ToolSource,
} from '@cycgraph/orchestrator';

/** Options for the retry reference graph. */
export interface RetryGraphOptions {
  /** Trajectory input — describes the unreliable resource the agent should access. */
  input: string;

  /**
   * Tool name the agent will be told about. Must match a canned tool the
   * recording script registers via the mock resolver. Defaults to
   * `'flaky_fetch'`.
   */
  toolName?: string;

  /** Model name (default: `'claude-sonnet-4-6'`). */
  model?: string;

  /** Provider name (default: `'anthropic'`). */
  provider?: string;

  /** Memory key for the agent's final narrative (default: `'narrative'`). */
  outputKey?: string;

  /**
   * Maximum LLM steps the agent may take. Higher than usual so the model
   * has room to call the flaky tool several times. (default: `8`).
   */
  maxSteps?: number;

  /** Max execution time in ms (default: `180 000`). */
  maxExecutionTimeMs?: number;
}

/** Constructed components for a retry SUT run. */
export interface RetryGraphArtifacts {
  graph: Graph;
  initialState: WorkflowState;
  agentRegistry: AgentRegistry;
  outputKey: string;
  toolName: string;
}

/**
 * Build a single-agent graph configured for retry/error trajectories. The
 * agent is given access to one mock tool (`toolName`) that the recording
 * script's mock resolver will program to fail the first few calls.
 */
export function buildRetryGraph(opts: RetryGraphOptions): RetryGraphArtifacts {
  const outputKey = opts.outputKey ?? 'narrative';
  const toolName = opts.toolName ?? 'flaky_fetch';
  const registry = new InMemoryAgentRegistry();

  const tools: ToolSource[] = [
    { type: 'mcp', server_id: 'mock', tool_names: [toolName] },
  ];

  const agentId = registry.register({
    name: 'Retry Agent (SUT)',
    description: 'Handles an unreliable resource and narrates the outcome',
    model: opts.model ?? 'claude-sonnet-4-6',
    provider: opts.provider ?? 'anthropic',
    system_prompt: [
      'You are tasked with completing the goal using the tools available to you.',
      `The "${toolName}" tool may fail on the first attempts; retry up to 5 times before giving up.`,
      'After completing the task (or exhausting retries), produce a concise narrative describing:',
      '  - how many attempts you made',
      '  - what each attempt returned',
      '  - the final outcome',
      'Save this narrative to memory.',
    ].join(' '),
    temperature: 0.2,
    max_steps: opts.maxSteps ?? 8,
    tools,
    permissions: {
      read_keys: ['goal', 'constraints'],
      write_keys: [outputKey],
    },
  });

  const graph = createGraph({
    name: 'retry-sut',
    description: 'SUT reference graph: one agent uses a flaky tool with retries',
    nodes: [
      {
        id: 'agent',
        type: 'agent',
        agent_id: agentId,
        read_keys: ['goal', 'constraints'],
        write_keys: [outputKey],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 500,
          max_backoff_ms: 5_000,
        },
        requires_compensation: false,
      },
    ],
    edges: [],
    start_node: 'agent',
    end_nodes: ['agent'],
  });

  const initialState = createWorkflowState({
    workflow_id: graph.id,
    goal: opts.input,
    max_execution_time_ms: opts.maxExecutionTimeMs ?? 180_000,
  });

  return { graph, initialState, agentRegistry: registry, outputKey, toolName };
}

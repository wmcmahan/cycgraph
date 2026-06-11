/**
 * Supervisor Reference Graph
 *
 * Builds a cyclic hub-and-spoke graph: one supervisor agent dynamically
 * routes work between 3 specialist agents (research / write / edit) until
 * it emits the `__done__` sentinel. Covers the `supervisor` /
 * `multi-agent` / `delegation` trajectory tag families.
 *
 * The supervisor's read/write permissions are wildcard so it can observe
 * specialist outputs; each specialist has scoped permissions matching
 * its role.
 *
 * @module sut/graphs/supervisor
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
} from '@cycgraph/orchestrator';

/** Options for the supervisor reference graph. */
export interface SupervisorGraphOptions {
  /** Trajectory input — seeded as the workflow goal. */
  input: string;

  /** Model name shared by all four agents (default: `'claude-sonnet-4-6'`). */
  model?: string;

  /** Provider name (default: `'anthropic'`). */
  provider?: string;

  /** Max iterations the supervisor may take before forced termination (default: `8`). */
  maxIterations?: number;

  /**
   * Memory key that holds the final output. The editor agent writes to
   * `final_draft` by default; pass an override only if your golden uses a
   * different key.
   */
  outputKey?: string;

  /** Max execution time in ms (default: `300 000`). */
  maxExecutionTimeMs?: number;
}

/** Constructed components for a supervisor SUT run. */
export interface SupervisorGraphArtifacts {
  graph: Graph;
  initialState: WorkflowState;
  agentRegistry: AgentRegistry;
  outputKey: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Build a supervisor + 3-specialist graph for one trajectory.
 *
 * Topology: `supervisor` ⇄ {`research`, `write`, `edit`}. Supervisor
 * decides the next worker each turn; specialists return to the supervisor
 * after completing their step. Termination via `__done__` sentinel.
 */
export function buildSupervisorGraph(
  opts: SupervisorGraphOptions,
): SupervisorGraphArtifacts {
  const model = opts.model ?? DEFAULT_MODEL;
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const outputKey = opts.outputKey ?? 'final_draft';
  const registry = new InMemoryAgentRegistry();

  const supervisorId = registry.register({
    name: 'Supervisor (SUT)',
    description: 'Routes work between research, write, and edit specialists',
    model,
    provider,
    system_prompt: [
      'You coordinate a team of three specialists to complete the goal.',
      'Available workers: "research" (gathers facts), "write" (produces a draft), "edit" (polishes prose).',
      'Inspect current state and decide which worker should act next.',
      'Typical flow: research → write → edit. Loop back if quality is insufficient.',
      'When final_draft is ready, route to "__done__" to complete the workflow.',
    ].join(' '),
    temperature: 0.2,
    max_steps: 3,
    tools: [],
    permissions: { read_keys: ['*'], write_keys: ['*'] },
  });

  const researcherId = registry.register({
    name: 'Researcher (SUT)',
    description: 'Gathers concise factual notes on the goal',
    model,
    provider,
    system_prompt: [
      'You are a research specialist.',
      'Given the goal, produce concise factual notes as bullet points.',
      'Focus on key facts and notable perspectives. Avoid speculation.',
    ].join(' '),
    temperature: 0.4,
    max_steps: 3,
    tools: [],
    permissions: {
      read_keys: ['goal', 'constraints'],
      write_keys: ['research_notes'],
    },
  });

  const writerId = registry.register({
    name: 'Writer (SUT)',
    description: 'Produces a polished draft from research notes',
    model,
    provider,
    system_prompt: [
      'You are a writer.',
      'Using the provided research notes, produce a clear, engaging draft.',
      'Keep it under 400 words. Use plain language.',
    ].join(' '),
    temperature: 0.6,
    max_steps: 3,
    tools: [],
    permissions: {
      read_keys: ['goal', 'research_notes'],
      write_keys: ['draft'],
    },
  });

  const editorId = registry.register({
    name: 'Editor (SUT)',
    description: 'Polishes a draft into the final version',
    model,
    provider,
    system_prompt: [
      'You are an editor.',
      'Review the draft for clarity, grammar, flow, and accuracy.',
      'Produce a polished final version under the same word budget.',
    ].join(' '),
    temperature: 0.3,
    max_steps: 3,
    tools: [],
    permissions: {
      read_keys: ['goal', 'draft'],
      write_keys: [outputKey],
    },
  });

  const failurePolicy = {
    max_retries: 2,
    backoff_strategy: 'exponential' as const,
    initial_backoff_ms: 1_000,
    max_backoff_ms: 60_000,
  };

  const graph = createGraph({
    name: 'supervisor-sut',
    description: 'SUT reference graph: supervisor + research/write/edit specialists',
    nodes: [
      {
        id: 'supervisor',
        type: 'supervisor',
        agent_id: supervisorId,
        read_keys: ['*'],
        write_keys: ['*'],
        supervisor_config: {
          managed_nodes: ['research', 'write', 'edit'],
          max_iterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        },
        failure_policy: failurePolicy,
        requires_compensation: false,
      },
      {
        id: 'research',
        type: 'agent',
        agent_id: researcherId,
        read_keys: ['goal', 'constraints'],
        write_keys: ['research_notes'],
        failure_policy: failurePolicy,
        requires_compensation: false,
      },
      {
        id: 'write',
        type: 'agent',
        agent_id: writerId,
        read_keys: ['goal', 'research_notes'],
        write_keys: ['draft'],
        failure_policy: failurePolicy,
        requires_compensation: false,
      },
      {
        id: 'edit',
        type: 'agent',
        agent_id: editorId,
        read_keys: ['goal', 'draft'],
        write_keys: [outputKey],
        failure_policy: failurePolicy,
        requires_compensation: false,
      },
    ],
    edges: [
      { source: 'supervisor', target: 'research' },
      { source: 'supervisor', target: 'write' },
      { source: 'supervisor', target: 'edit' },
      { source: 'research', target: 'supervisor' },
      { source: 'write', target: 'supervisor' },
      { source: 'edit', target: 'supervisor' },
    ],
    start_node: 'supervisor',
    end_nodes: [],
  });

  const initialState = createWorkflowState({
    workflow_id: graph.id,
    goal: opts.input,
    max_execution_time_ms: opts.maxExecutionTimeMs ?? DEFAULT_TIMEOUT_MS,
  });

  return { graph, initialState, agentRegistry: registry, outputKey };
}

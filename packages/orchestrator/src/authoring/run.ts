/**
 * run() and state() — one-call execution
 *
 * `run()` collapses the setup a raw run needs — agent registry, provider
 * config, workflow state, persistence, runner — into a single call. It
 * returns the final workflow memory.
 *
 * `run()` scopes the graph's agents and providers into the run via
 * `GraphRunnerOptions.registry`/`providers` — no process-global mutation, so
 * concurrent facade runs never contaminate each other. See
 * docs/plans/authoring-facade.md.
 *
 * @module authoring/run
 */

import type { Graph } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import { createWorkflowState, type WorkflowStateConfig } from '../types/state.js';
import type { PersistenceProvider } from '../persistence/interfaces.js';
import { InMemoryAgentRegistry, InMemoryPersistenceProvider } from '../persistence/in-memory.js';
import type { ProviderRegistry } from '../agent/provider-registry.js';
import { GraphRunner, type GraphRunnerOptions } from '../runner/graph-runner.js';
import { agentsForGraph, toolsForGraph } from './graph.js';

/**
 * `state()` — build a {@link WorkflowState} explicitly (alias of
 * `createWorkflowState`) for when you want to seed it yourself rather than
 * pass raw input to {@link run}.
 */
export function state(input: WorkflowStateConfig): WorkflowState {
  return createWorkflowState(input);
}

/** Input to {@link run}: the workflow-state authoring shape (minus `workflowId`, taken from the graph). */
export type RunInput = Omit<WorkflowStateConfig, 'workflowId'>;

/** Options for {@link run}. */
export interface RunOptions {
  /** Persistence backend. Defaults to a fresh in-memory provider. */
  persistence?: PersistenceProvider;
  /**
   * Provider registry, scoped to this run. When omitted, the run inherits
   * the global provider registry (built-ins reading env keys, plus anything
   * registered via the deprecated global path, e.g. Ollama).
   */
  providers?: ProviderRegistry;
  /** Extra GraphRunner options (memoryRetriever, tools, middleware, …). */
  runner?: Omit<GraphRunnerOptions, 'persistState' | 'persistStateFn'>;
}

function isWorkflowState(value: RunInput | WorkflowState): value is WorkflowState {
  return 'run_id' in value && 'status' in value;
}

/**
 * Run a graph and return its final memory.
 *
 * @param g - A graph, typically from `graph()` (facade agents auto-register).
 * @param input - Workflow input (`goal` required) or a prebuilt `WorkflowState`.
 * @param options - Persistence / providers / runner overrides.
 * @returns The final `WorkflowState.memory`.
 */
export async function run(
  g: Graph,
  input: RunInput | WorkflowState,
  options: RunOptions = {},
): Promise<Record<string, unknown>> {
  // Scope the graph's facade agents into a fresh registry for this run — no
  // process-global mutation, so concurrent runs never contaminate. A graph
  // WITHOUT facade agents (raw createGraph, or a facade graph that was
  // serialized — the agent stash is keyed on object identity) gets NO
  // registry here, so agent resolution falls back to whatever the caller
  // configured (runner.registry override, or the global factory).
  const stashed = agentsForGraph(g);
  const runnerOverride = options.runner ?? {};

  if (stashed.length > 0 && 'registry' in runnerOverride) {
    throw new Error(
      'This graph carries inline agent() definitions, but runner.registry would replace the ' +
        'registry they are registered into — they would silently fail to load. Either reference ' +
        'pre-registered agents by id (node({ agentId })) with your registry, or drop the override.',
    );
  }

  let registry: InMemoryAgentRegistry | undefined;
  if (stashed.length > 0) {
    registry = new InMemoryAgentRegistry();
    for (const config of stashed) registry.register(config);
  }

  // Inline tool() references were collapsed to `{ type: 'custom', name }` by
  // graph(); wire their implementations onto the runner automatically. The
  // identity filter makes passing the same reference in both places a no-op;
  // two DISTINCT tools sharing a name still fail loudly at runner
  // construction (duplicate-name check in the composed tool resolution).
  const overrideTools = runnerOverride.tools ?? [];
  const inlineTools = toolsForGraph(g).filter((t) => !overrideTools.includes(t));
  const mergedTools = [...inlineTools, ...overrideTools];

  const workflowState = isWorkflowState(input)
    ? input
    : createWorkflowState({ workflowId: g.id, ...input });

  const persistence = options.persistence ?? new InMemoryPersistenceProvider();
  const runner = new GraphRunner(g, workflowState, {
    ...(registry ? { registry } : {}),
    // Providers are scoped only when explicitly given; otherwise the runner
    // inherits the global provider registry (built-ins by default, plus
    // anything registered via the deprecated global path, e.g. Ollama).
    ...(options.providers ? { providers: options.providers } : {}),
    ...runnerOverride,
    ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
    persistState: (s) => persistence.saveWorkflowSnapshot(s),
  });

  const finalState = await runner.run();
  return finalState.memory;
}

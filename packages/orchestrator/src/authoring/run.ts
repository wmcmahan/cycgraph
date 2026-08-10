/**
 * run() and state() — one-call execution
 *
 * `run()` collapses the setup a raw run needs — agent registry, provider
 * config, workflow state, persistence, runner — into a single call. It
 * returns the final workflow memory.
 *
 * `run()` scopes the graph's agents and providers into the run via
 * `GraphRunnerOptions.registry`/`providers` — no process-global mutation, so
 * concurrent facade runs never contaminate each other.
 *
 * Composition: the wiring is TRANSITIVE.
 * `subgraph()` children collected by `graph()` are resolved through an
 * auto-built `loadGraph`, and each child's own agents/tools/grandchildren
 * are folded into the same run scope — the multi-graph closure. A
 * caller-supplied `loadGraph` wins for ids it resolves; the stash covers
 * the rest (the Phase 2 package-resolver seam).
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
import { collectClosure } from './closure.js';

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
 * @param g - A graph, typically from `graph()` (facade agents auto-register;
 *   `subgraph()` children auto-resolve through a run-scoped `loadGraph`).
 * @param input - Workflow input (`goal` required) or a prebuilt `WorkflowState`.
 * @param options - Persistence / providers / runner overrides.
 * @returns The final `WorkflowState.memory`.
 */
export async function run(
  g: Graph,
  input: RunInput | WorkflowState,
  options: RunOptions = {},
): Promise<Record<string, unknown>> {
  // Scope the composition's facade agents into a fresh registry for this
  // run — no process-global mutation, so concurrent runs never contaminate.
  // A graph WITHOUT facade agents (raw createGraph, or a facade graph that
  // was serialized — the stashes are keyed on object identity) gets NO
  // registry here, so agent resolution falls back to whatever the caller
  // configured (runner.registry override, or the global factory).
  const closure = collectClosure(g);
  const runnerOverride = options.runner ?? {};

  if (closure.agents.length > 0 && 'registry' in runnerOverride) {
    throw new Error(
      'This graph carries inline agent() definitions, but runner.registry would replace the ' +
      'registry they are registered into — they would silently fail to load. Either reference ' +
      'pre-registered agents by id (node({ agentId })) with your registry, or drop the override.',
    );
  }

  let registry: InMemoryAgentRegistry | undefined;
  if (closure.agents.length > 0) {
    registry = new InMemoryAgentRegistry();
    for (const config of closure.agents) registry.register(config);
  }

  // Inline tool() references were collapsed to `{ type: 'custom', name }` by
  // graph(); wire their implementations onto the runner automatically. The
  // identity filter makes passing the same reference in both places a no-op;
  // two DISTINCT tools sharing a name still fail loudly at runner
  // construction (duplicate-name check in the composed tool resolution).
  const overrideTools = runnerOverride.tools ?? [];
  const inlineTools = closure.tools.filter((t) => !overrideTools.includes(t));
  const mergedTools = [...inlineTools, ...overrideTools];

  // subgraph() children resolve through a loadGraph built from the stash.
  // A caller-supplied loadGraph wins for ids it resolves (pre-registered or
  // third-party graphs); the stash covers the in-scope children. Child
  // runners inherit this option through the executor context, so
  // grandchildren resolve identically.
  const callerLoadGraph = runnerOverride.loadGraph ?? runnerOverride.loadGraphFn;
  const loadGraph =
    closure.children.size > 0
      ? async (graphId: string): Promise<Graph | null> => {
        if (callerLoadGraph) {
          const resolved = await callerLoadGraph(graphId);
          if (resolved) return resolved;
        }
        return closure.children.get(graphId) ?? null;
      }
      : undefined;

  // Declared bundle ceilings thread to the runner so bundle children are
  // capped to their manifests. A caller-supplied map wins per id.
  const mergedCeilings = {
    ...closure.ceilings,
    ...(runnerOverride.capabilityCeilings ?? {}),
  };

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
    ...(loadGraph ? { loadGraph } : {}),
    ...(Object.keys(mergedCeilings).length > 0 ? { capabilityCeilings: mergedCeilings } : {}),
    persistState: (s) => persistence.saveWorkflowSnapshot(s),
  });

  const finalState = await runner.run();
  return finalState.memory;
}

/**
 * run() and state() — one-call execution
 *
 * `run()` collapses the setup a raw run needs (agent registry, provider
 * config, workflow state, persistence, runner) into a single call and
 * returns the final workflow memory.
 *
 * Agents and providers are scoped into the run via
 * `GraphRunnerOptions.registry`/`providers`, never process globals, so
 * concurrent runs cannot contaminate each other.
 *
 * The wiring is transitive: `subgraph()` children are resolved through an
 * auto-built `loadGraph`, and each child's own agents, tools, and
 * grandchildren fold into the same run scope. A caller-supplied `loadGraph`
 * wins for ids it resolves.
 *
 * @module authoring/run
 */

import type { Graph } from '../graph/graph.js';
import type { WorkflowState } from '../state/state.js';
import { createWorkflowState, type WorkflowStateConfig } from '../state/state.js';
import type { PersistenceProvider, AgentRegistry } from '../persistence/interfaces.js';
import type { EventLogWriter } from '../persistence/event-log.js';
import { InMemoryEventLogWriter } from '../persistence/event-log.js';
import { InMemoryAgentRegistry, InMemoryPersistenceProvider } from '../persistence/in-memory.js';
import type { ProviderRegistry } from '../agents/providers/provider-registry.js';
import { GraphRunner, type GraphRunnerOptions } from '../execution/engine/graph-runner.js';
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
 * Everything a caller needs to inspect, resume, or fork a run after it ends.
 *
 * `run()` returns memory alone, which is the right answer for a workflow you
 * execute once. Anything that refers back to the run — a fork, a replay, a
 * usage query — needs the run id and the log it was recorded into.
 */
export interface RecordedRun {
  /** The run's id, the handle every after-the-fact API takes. */
  runId: string;
  /** Final `WorkflowState.memory`, identical to what {@link run} returns. */
  memory: Record<string, unknown>;
  /** Final state, for status, cost totals, and per-node breakdowns. */
  state: WorkflowState;
  /** The log the run was recorded into. */
  eventLog: EventLogWriter;
  /** The provider holding the graph and run rows. */
  persistence: PersistenceProvider;
  /**
   * The run-scoped registry holding this graph's inline `agent()` definitions.
   *
   * `graph()` collects inline agents into a registry built per run, so they
   * exist nowhere else. Anything that re-runs part of this graph later — a
   * fork, a replay — needs it to resolve those agents. Absent when the graph
   * references pre-registered agents by id instead.
   */
  registry?: AgentRegistry;
}

/** Shared wiring for {@link run} and {@link runRecorded}. */
function buildRunner(
  g: Graph,
  input: RunInput | WorkflowState,
  options: RunOptions,
  extra?: Partial<GraphRunnerOptions>,
): {
  runner: GraphRunner;
  persistence: PersistenceProvider;
  workflowState: WorkflowState;
  registry?: AgentRegistry;
} {
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
    ...extra,
    persistState: (s) => persistence.saveWorkflowSnapshot(s),
  });

  return { runner, persistence, workflowState, registry };
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
  const { runner } = buildRunner(g, input, options);
  const finalState = await runner.run();
  return finalState.memory;
}

/**
 * Run a graph and keep everything needed to refer back to it.
 *
 * Same execution as {@link run}, three differences in what it leaves behind:
 * an `EventLogWriter` is wired (an in-memory one when the caller supplies
 * none), auto-compaction is off so the whole log stays addressable, and the
 * graph is saved before execution so the run row resolves back to it.
 *
 * Those are the preconditions for replaying or forking the run afterwards.
 * Compaction in particular deletes events behind the latest checkpoint, which
 * silently removes the early history a fork would target.
 *
 * @param g - A graph, as for {@link run}.
 * @param input - Workflow input (`goal` required) or a prebuilt `WorkflowState`.
 * @param options - Persistence / providers / runner overrides. A caller-supplied
 *   `runner.eventLog` or `runner.compactionInterval` wins.
 */
export async function runRecorded(
  g: Graph,
  input: RunInput | WorkflowState,
  options: RunOptions = {},
): Promise<RecordedRun> {
  const runnerOverride = options.runner ?? {};
  const eventLog = runnerOverride.eventLog ?? new InMemoryEventLogWriter();

  const { runner, persistence, workflowState, registry } = buildRunner(g, input, options, {
    eventLog,
    // A recorded run exists to be replayed. Compaction would delete the
    // events behind the latest checkpoint, so the default that keeps a long
    // run's log bounded is the wrong default here.
    compactionInterval: runnerOverride.compactionInterval ?? 0,
  });

  // A relational provider keys run rows to graphs, so the graph has to exist
  // before the run does. In-memory providers do not care, which is what makes
  // this easy to omit until a durable backend is wired.
  await persistence.saveGraph(g);

  const state = await runner.run();
  return {
    runId: workflowState.run_id,
    memory: state.memory,
    state,
    eventLog,
    persistence,
    ...(registry ? { registry } : {}),
  };
}

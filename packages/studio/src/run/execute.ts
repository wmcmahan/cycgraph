/**
 * Run driver
 *
 * Builds a scenario, streams it, records everything, and resumes it across
 * human-in-the-loop pauses until it reaches a terminal state.
 *
 * Drives `GraphRunner` directly rather than `run()`, for two reasons: the
 * playground needs the event stream, and it needs to keep hold of the agent
 * registry so a parameter can change an agent's model between runs, which
 * `run()` refuses to allow alongside the closure it builds itself.
 *
 * The registries are minted per run, not per session. Facade agents carry
 * pinned ids, so two scenarios in one sweep that both name an agent
 * `researcher` would otherwise overwrite each other in a shared registry and
 * silently run the wrong prompt.
 *
 * @module run/execute
 */

import { randomUUID } from 'node:crypto';
import {
  GraphRunner,
  InMemoryAgentRegistry,
  checkAssertion,
  createWorkflowState,
  getTracer,
  injectTraceContext,
  isTerminalEvent,
  withSpan,
  type AssertionResult,
  type HumanResponse,
  type StreamEvent,
  type WorkflowState,
} from '@cycgraph/orchestrator';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';
import { providersFor } from '../stack/index.js';
import { childGraphsOf, threadClosure } from './closure.js';
import { trialChangesFor } from '../improve/proposals.js';
import { applyChanges, type Change } from '@cycgraph/orchestrator';
import { RunRecorder, type RunUsage } from './recorder.js';

/** Reported to the caller as the run unfolds, for terminal or web rendering. */
export type ProgressHandler = (event: StreamEvent) => void;

/** Per-execution overrides the front end supplies. */
export interface ExecuteOptions {
  onProgress?: ProgressHandler;
  /**
   * Accepted proposals to run under, applied to the built graph and agents
   * before execution and stamped onto the run's record.
   */
  apply?: { ids: string[]; changes: Change[] };
  /**
   * Answers a pause when the scenario scripts none. A scenario's own handler
   * always wins, so a sweepable scenario stays non-interactive even when the
   * CLI would otherwise prompt.
   */
  fallbackHitl?: (question: string) => Promise<HumanResponse>;
  /**
   * A reviewer who is actually present, and who outranks the scenario's script.
   *
   * Every gated scenario here scripts its answer, which is what lets sweeps and
   * `fork-check` run unattended. That would also make a dashboard gate
   * unanswerable: the page would watch a decision it never made scroll past.
   * So an interactive answerer takes precedence — a script is what happens when
   * nobody is watching, not a decision that outranks someone who is.
   */
  hitl?: (question: string) => Promise<HumanResponse>;
  /**
   * Replace what the workflow is asked to do.
   *
   * A scenario fixes its own goal so its assertions mean something, but the
   * point of a playground is asking the same topology a different question.
   */
  goal?: string;
}

/** Everything one execution produced. */
export interface RunOutcome {
  runId: string;
  /** Directory holding this run's artifacts. */
  dir: string;
  status: string;
  durationMs: number;
  finalState?: WorkflowState;
  usage: RunUsage;
  evals: AssertionResult[];
  error?: string;
  /** How many times the run paused for a human and was resumed. */
  resumes: number;
}

/** Guards against a scripted answer that never satisfies the pause. */
const MAX_RESUMES = 20;

function usageOf(state: WorkflowState): RunUsage {
  return {
    totalTokens: state.total_tokens_used,
    totalCostUsd: state.total_cost_usd,
    nodesVisited: state.visited_nodes.length,
    ...(Object.keys(state.node_breakdown ?? {}).length > 0
      ? { byNode: state.node_breakdown }
      : {}),
  };
}

/** Default answer when a scenario scripts no `hitl` handler. */
const APPROVE: HumanResponse = { decision: 'approved' };

/**
 * Run one scenario at one parameter set.
 *
 * Never throws for a workflow-level failure: a failed or rejected run is an
 * outcome worth recording, which is the whole point of a stress harness. Only
 * a graph that cannot be authored at all is recorded as `build_failed`, since
 * an interface that rejects its own wiring is an outcome worth keeping.
 */
export async function executeScenario<P extends import('zod').ZodTypeAny>(
  scenario: Scenario<P>,
  params: import('zod').infer<P>,
  stack: Stack,
  options: ExecuteOptions = {},
): Promise<RunOutcome> {
  const runId = randomUUID();
  const recorder = await RunRecorder.open(stack.config.artifactRoot, {
    runId,
    scenarioId: scenario.id,
    params,
    stack: stack.config,
  });
  const started = Date.now();

  // `graph()` validates declared interfaces as it builds, so a mapping that
  // names an output the child never declares fails here rather than at run
  // time. That is a result, not a crash.
  let built: Awaited<ReturnType<typeof scenario.build>>;
  try {
    built = await scenario.build(params, stack);
    // Every scenario runs strict: a read of a key nothing produces and no
    // `inputs` entry declares fails preflight instead of silently resolving to
    // an empty value. A harness for finding mistakes should not warn about one
    // and continue.
    //
    // Assigned in place. A facade-authored graph's inline agents and tools are
    // tracked in WeakMaps keyed on the graph's object identity, so copying it
    // — even with a spread — orphans every inline definition and the run fails
    // preflight wiring instead.
    built.graph.strict_keys = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recorder.close({ status: 'build_failed', error: message });
    return {
      runId,
      dir: recorder.dir,
      status: 'build_failed',
      durationMs: Date.now() - started,
      usage: { totalTokens: 0, totalCostUsd: 0, nodesVisited: 0 },
      evals: [],
      resumes: 0,
      error: message,
    };
  }

  // A scenario that drives itself owns the whole run: it is handed the same
  // recorder so its artifacts match, and reports the outcome the default loop
  // would have derived from the terminal event.
  if (scenario.drive) {
    let status = 'unknown';
    let error: string | undefined;
    let finalState: WorkflowState | undefined;

    // Spanned like any other run. A driven scenario's work happens in child
    // processes, so the span is worth little on its own — what makes it worth
    // opening is `traceContext`, which the scenario passes to the workers it
    // spawns so their spans land in this trace instead of nowhere.
    await withSpan(getTracer('playground.run'), 'playground.run', async (rootSpan) => {
      rootSpan.setAttribute('playground.scenario', scenario.id);
      rootSpan.setAttribute('playground.driven', true);

      const traceId = rootSpan.spanContext().traceId;
      if (/[^0]/.test(traceId)) await recorder.setTraceId(traceId);

      try {
        const result = await scenario.drive!(params, stack, {
          runId,
          recorder,
          traceContext: injectTraceContext({}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
        status = result.status;
        finalState = result.finalState;
        error = result.error;
        if (result.notes) await recorder.writeNotes(result.notes);
      } catch (err) {
        status = 'crashed';
        error = err instanceof Error ? err.message : String(err);
      }
    });

    const usage = finalState ? usageOf(finalState) : { totalTokens: 0, totalCostUsd: 0, nodesVisited: 0 };
    await recorder.writeUsage(usage);
    const evals = finalState ? await runEvals(scenario, params, stack, finalState) : [];
    await recorder.writeEvals(evals);
    await recorder.close({ status, ...(error ? { error } : {}) });

    return {
      runId,
      dir: recorder.dir,
      status,
      durationMs: Date.now() - started,
      ...(finalState ? { finalState } : {}),
      usage,
      evals,
      resumes: 0,
      ...(error ? { error } : {}),
    };
  }

  const agents = new InMemoryAgentRegistry();
  const closure = await threadClosure(built.graph, agents);

  // Accepted proposals land here: after the closure has materialised inline
  // agents into the registry, before anything reads the graph. Nodes are
  // assigned in place because the facade keys its closures on the graph
  // object's identity, and the stamp goes on the record because which
  // configuration produced a run is the first thing its reader needs.
  // The ledger is consulted here rather than by each caller, because a run
  // of this scenario is a run of it as currently accepted — from the CLI, a
  // sweep, the dashboard, or fork-check's conformance bases alike. An
  // explicit option still wins, so a caller that means "exactly this set"
  // can say so.
  const apply = options.apply
    ?? await trialChangesFor(stack.config.artifactRoot, scenario.id);
  if (apply.changes.length > 0) {
    const applied = await applyChanges(built.graph, agents, apply.changes);
    built.graph.nodes = applied.graph.nodes;
    for (const entry of applied.agents) {
      await agents.updateAgent(entry.id, {
        model: entry.model,
        provider: entry.provider,
        systemPrompt: entry.system_prompt,
        ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      });
    }
    await recorder.amendMeta({
      appliedProposals: apply.ids,
      appliedChanges: apply.changes,
    });
  }

  const providers = providersFor(stack.config.model, stack.config.endpoints.ollama);

  // One run, one id. The recorder names its artifact directory with `runId`
  // and the engine keys events and run rows on `state.run_id`; letting those
  // diverge means an artifact on disk cannot be traced to its own events,
  // which is what forking a recorded run needs.
  let currentState: WorkflowState = createWorkflowState({
    workflowId: built.graph.id,
    runId,
    ...built.input,
    ...(options.goal ? { goal: options.goal } : {}),
  });
  let resumes = 0;
  let status = 'unknown';
  let error: string | undefined;

  // Present reviewer, then the scenario's script, then the caller's fallback.
  const answer = options.hitl ?? built.hitl ?? options.fallbackHitl ?? (async () => APPROVE);

  // Durable storage is relational: `workflow_events.run_id` references
  // `workflow_runs`, which in turn references `graphs`. Without both rows
  // every event append fails its foreign key and the runner halts after four
  // flushes. Unconditional because the in-memory provider implements the same
  // calls, so there is no branch to keep in sync.
  await stack.persistence.saveGraph(built.graph);
  for (const child of childGraphsOf(built.graph)) {
    await stack.persistence.saveGraph(child);
  }
  await stack.persistence.saveWorkflowRun(currentState);

  try {
    // A scenario-level span above the engine's own `workflow.run`, carrying
    // what the engine has no notion of and owning the trace id the artifacts
    // link to. Resumes share it, so one scenario run is one trace.
    await withSpan(getTracer('playground.run'), 'playground.run', async (rootSpan) => {
      rootSpan.setAttribute('playground.scenario', scenario.id);
      rootSpan.setAttribute('workflow.run_id', currentState.run_id);

      const traceId = rootSpan.spanContext().traceId;
      if (/[^0]/.test(traceId)) await recorder.setTraceId(traceId);

      // Each pause ends one stream. Resuming means a fresh runner over the
      // paused state, which is how the engine's own HITL path works.
      for (;;) {
        const runner = new GraphRunner(built.graph, currentState, {
          persistState: async (snapshot) => {
            await recorder.snapshot(snapshot);
            await stack.persistence.saveWorkflowSnapshot(snapshot);
          },
          eventLog: stack.eventLog,
          // Every playground run is forkable after the fact. Auto-compaction
          // deletes events behind the newest checkpoint, which would silently
          // put a long scenario's early fork points out of reach.
          compactionInterval: 0,
          registry: agents,
          ...(providers ? { providers } : {}),
          ...(closure.loadGraph ? { loadGraph: closure.loadGraph } : {}),
          ...built.runner,
          // Inline tools merge with anything the scenario wired explicitly,
          // rather than either side silently winning.
          tools: [...closure.tools, ...(built.runner.tools ?? [])],
          logger: (entry) => recorder.log(entry),
        });

        if (resumes > 0) {
          const response = await answer(waitingReason(currentState));
          // A decision arriving after the gate's deadline is refused by the
          // engine, which then resumes into its timeout.
          runner.applyHumanResponse(response);
        }

        // Cancellation comes from outside the graph, so the signal is the
        // driver's to hold. The timer is per attempt: a resumed run gets its
        // own window rather than inheriting an already-fired one.
        const aborter = built.abortAfterMs ? new AbortController() : undefined;
        const abortTimer = aborter
          ? setTimeout(() => aborter.abort(), built.abortAfterMs)
          : undefined;

        let terminal: StreamEvent | undefined;
        try {
        for await (const event of runner.stream(aborter ? { signal: aborter.signal } : undefined)) {
          await recorder.event(event);
          options.onProgress?.(event);
          if (isTerminalEvent(event)) terminal = event;
        }
        } finally {
          if (abortTimer) clearTimeout(abortTimer);
        }

        if (!terminal || !('state' in terminal)) {
          status = 'unknown';
          break;
        }

        currentState = terminal.state;

        if (terminal.type !== 'workflow:waiting') {
          status = currentState.status;
          break;
        }

        resumes++;
        if (resumes > MAX_RESUMES) {
          status = 'waiting';
          error = `Still waiting after ${MAX_RESUMES} resumes; the scripted answer never satisfied the pause.`;
          break;
        }
      }
    });
  } catch (err) {
    status = 'crashed';
    error = err instanceof Error ? err.message : String(err);
  }

  const usage = usageOf(currentState);
  await recorder.writeUsage(usage);

  const evals = await runEvals(scenario, params, stack, currentState);
  await recorder.writeEvals(evals);

  await recorder.close({ status, ...(error ? { error } : {}) });

  return {
    runId,
    dir: recorder.dir,
    status,
    durationMs: Date.now() - started,
    finalState: currentState,
    usage,
    evals,
    resumes,
    ...(error ? { error } : {}),
  };
}

/** What the workflow is blocked on, passed to the scenario's answer handler. */
function waitingReason(state: WorkflowState): string {
  // `prompt_message` is what both pausers actually write: the approval node
  // from `approval_config.prompt_message`, the a2a node from the remote
  // agent's own message. `question` is accepted too, for any caller that
  // stashes a pause under that name.
  const pending = state.pending_approval as Record<string, unknown> | undefined;
  const message = pending?.['prompt_message'] ?? pending?.['question'];
  if (typeof message === 'string' && message.length > 0) return message;

  return state.waiting_for
    ? `Workflow is waiting: ${state.waiting_for}`
    : 'Workflow is waiting for a human response.';
}

/**
 * Check a scenario's assertions against the final state.
 *
 * An assertion that throws is recorded as failed rather than propagated: an
 * eval is an observation about the run, not a gate on it.
 */
/**
 * Check a scenario's assertions against a state it did not itself produce.
 *
 * Exported for forking: the assertions are what the scenario says the run is
 * supposed to achieve, so running them against a variant is the cheapest
 * objective answer to whether the fork was an improvement.
 */
export async function runEvals<P extends import('zod').ZodTypeAny>(
  scenario: Scenario<P>,
  params: import('zod').infer<P>,
  stack: Stack,
  finalState: WorkflowState,
): Promise<AssertionResult[]> {
  const assertions = scenario.evals?.(params, stack) ?? [];

  return Promise.all(
    assertions.map(async (assertion) => {
      try {
        return await checkAssertion(assertion, finalState);
      } catch (err) {
        return {
          assertion,
          passed: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

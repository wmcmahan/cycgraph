/**
 * Forking recorded runs
 *
 * Counterfactual replay is not a scenario. It is a verb over runs, the same
 * way a sweep is a verb over parameters: every scenario already records an
 * event log, so every run under `.playground/runs/` is forkable without any
 * per-scenario support.
 *
 * Two entry points. {@link forkRecordedRun} answers a what-if about one run.
 * {@link checkForkConformance} forks a run at every point it exposes, with no
 * change, and asserts each one reproduces the original — the fidelity
 * invariant, checked against real graphs rather than one written to pass.
 *
 * The conformance pass costs nothing. A fork with no change memoizes every
 * tail node, because every node's inputs are by definition unchanged, so the
 * whole thing runs on recorded outputs and makes no model calls at all.
 *
 * @module run/fork
 */

import {
  applyChanges,
  ChangeSchema,
  forkInChild,
  estimateSweep,
  fork,
  forkPoints,
  resolveTarget,
  type Change,
  type ForkPoint,
  type ForkResult,
  type WorkflowState,
  type RunDiff,
  type SuppressedEffect,
  type GraphRunnerMiddleware,
  type HumanResponse,
  type AssertionResult,
  canonicalEquals,
} from '@cycgraph/orchestrator';
import type { Graph } from '@cycgraph/orchestrator';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';
import { randomUUID } from 'node:crypto';
import { threadClosure } from './closure.js';
import { RunRecorder } from './recorder.js';
import { findRun } from './history.js';
import { runEvals } from './execute.js';
import { judgeFork, type Verdict } from '../improve/verdict.js';
import { InMemoryAgentRegistry } from '@cycgraph/orchestrator';
import { providersFor } from '../stack/index.js';

/** What a fork of a recorded run reports back. */
export interface ForkOutcome {
  runId: string;
  baseRunId: string;
  /** Directory holding this fork's artifacts. */
  dir: string;
  durationMs: number;
  status: string;
  /** Rendered comparison against the base run. */
  report: string;
  incurredCostUsd: number;
  /** Tail nodes served from the recording rather than executed. */
  memoized: number;
  /** Where the variant began diverging. */
  forkSequenceId: number;
  /** Node the tail started with. */
  forkNodeId?: string;
  /** Structured comparison against the base run. */
  diff?: RunDiff;
  /** Node ids served from the recording. */
  memoHits: string[];
  /** Side effects the guard held back. */
  suppressed: SuppressedEffect[];
  /** The scenario's assertions, checked against the fork. */
  evals: AssertionResult[];
  /** Whether the fork improved on the run it forked, and why. */
  verdict: Verdict;
}

/** One fork point's conformance verdict. */
export interface ConformanceEntry {
  /** How the point was addressed. */
  point: string;
  nodeId: string;
  sequence: number;
  /** Whether the null fork reproduced the base run exactly. */
  faithful: boolean;
  /** What differed, when it did not. */
  divergence?: string;
}

/** A scenario's conformance result. */
export interface ConformanceResult {
  scenarioId: string;
  baseRunId: string;
  baseStatus: string;
  entries: ConformanceEntry[];
  /** Points that reproduced the base run exactly. */
  faithful: number;
  /** A fork that could not be taken at all, and why. */
  errors: Array<{ point: string; message: string }>;
}

/**
 * Rebuild everything a scenario's graph needs to execute again.
 *
 * A fork re-runs real nodes, so it needs the same wiring the original run had:
 * the agents, the inline tools, the MCP resolver, the memory writer, the
 * subgraph loader. Assembling less of it produces preflight failures that look
 * like fork bugs and are not — reflection nodes demanding a `memoryWriter`,
 * tool nodes demanding a resolver.
 */
async function rewire(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  baseRunId?: string,
) {
  const built = await scenario.build(params as never, stack);
  const agents = new InMemoryAgentRegistry();
  const closure = await threadClosure(built.graph, agents);
  const providers = providersFor(stack.config.model, stack.config.endpoints.ollama);

  // `GraphSchema.id` defaults to a fresh uuid, so rebuilding a scenario yields
  // a graph that is structurally the same and identified differently. A fork
  // has to run the graph the base run actually executed: the variant's run row
  // references it, and a rebuilt id points at a row that was never written.
  // Agent ids are deterministic across builds, so the persisted graph's agent
  // references resolve against the registry rebuilt above.
  const recorded = baseRunId ? await loadRecordedGraph(stack, baseRunId) : undefined;
  let graph = recorded ?? built.graph;

  // A run stamped with applied proposals executed under them, so its forks
  // must too. The recorded graph already carries the config side; the agent
  // side lives in the registry this rewire just rebuilt from source, which
  // knows nothing about the ledger — so the run's own recorded changes are
  // re-applied here. Idempotent where the graph is already patched.
  if (baseRunId) {
    const stamped = (await findRun(stack.config.artifactRoot, baseRunId))?.meta.appliedChanges;
    if (Array.isArray(stamped) && stamped.length > 0) {
      const applied = await applyChanges(graph, agents, stamped.map((c) => ChangeSchema.parse(c)));
      graph = applied.graph;
      for (const entry of applied.agents) {
        await agents.updateAgent(entry.id, {
          model: entry.model,
          provider: entry.provider,
          systemPrompt: entry.system_prompt,
          ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
        });
      }
    }
  }

  const runner = {
    ...(providers ? { providers } : {}),
    ...(closure.loadGraph ? { loadGraph: closure.loadGraph } : {}),
    ...built.runner,
    tools: [...closure.tools, ...(built.runner.tools ?? [])],
  };

  // The freshly authored graph, beside the recorded one: node ids match, but
  // every `graph()` build mints new graph ids, so the recorded graph's
  // subgraph references and the rebuild's closure disagree on child identity.
  // Callers that must resolve a RECORDED child id translate through this.
  return { built: { ...built, graph }, agents, runner, authoredGraph: built.graph };
}

/** The graph a recorded run executed, when the provider still has it. */
async function loadRecordedGraph(stack: Stack, runId: string): Promise<Graph | undefined> {
  const row = await stack.persistence.loadWorkflowRun(runId);
  if (!row) return undefined;
  return (await stack.persistence.loadGraph(row.graph_id)) ?? undefined;
}

/** A fork point, with what the node there can actually be asked to do. */
export interface ForkPointInfo {
  sequenceId: number;
  nodeId: string;
  occurrence: number;
  iteration: number;
  /** The node's type, so a picker can say what it is. */
  nodeType: string;
  /**
   * Whether an agent change (model, prompt, temperature) resolves here.
   *
   * A tool, router, approval, or synthesizer node drives no agent, so offering
   * to change its model is offering a refusal. The picker needs to know before
   * it renders the form, not after the fork fails.
   */
  hasAgent: boolean;
  /** Dotted roles this node exposes, for the nodes that carry several agents. */
  roles: string[];
}

/** The points a recorded run exposes, for a picker. */
export async function forkPointsForRun(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  runId: string,
): Promise<ForkPointInfo[]> {
  const points = forkPoints(await stack.eventLog.loadEvents(runId));
  const { built } = await rewire(scenario, params, stack, runId);
  const byId = new Map(built.graph.nodes.map((n) => [n.id, n]));

  return points.map((point) => {
    const node = byId.get(point.nodeId);
    // Ask the resolver rather than re-deriving what counts as an agent: the
    // two answers must agree, and only one of them decides whether the fork
    // succeeds.
    let hasAgent = false;
    try {
      if (node) hasAgent = resolveTarget(built.graph, point.nodeId).agentIds.length > 0;
    } catch {
      hasAgent = false;
    }

    return {
      ...point,
      nodeType: node?.type ?? 'unknown',
      hasAgent,
      roles: node ? rolesFor(built.graph, node.id) : [],
    };
  });
}

/** The dotted roles a node exposes, discovered by asking the resolver. */
function rolesFor(graph: Graph, nodeId: string): string[] {
  const candidates = ['candidate', 'evaluator', 'judge', 'voters', 'extractor'];
  return candidates.filter((role) => {
    try {
      return resolveTarget(graph, `${nodeId}.${role}`).agentIds.length > 0;
    } catch {
      return false;
    }
  });
}

/** The playground's fork options, shared by the parent and mid-child paths. */
interface ForkRecordedOptions {
  at?: ForkPoint;
  change?: Change | Change[];
  memoize?: boolean;
  /** Node ids allowed to perform their real side effects. */
  allow?: string[];
  /** Reports the tail's progress, so a caller can show it unfolding. */
  onNode?: (nodeId: string, phase: 'start' | 'done') => void;
  /** Answers a gate the tail reaches. */
  hitl?: (question: string) => Promise<HumanResponse>;
}

/**
 * Fork a recorded run at a boundary inside one of its subgraph children.
 *
 * The dispatch target for a namespaced address (`edit/locate`). The engine
 * runs the child variant and then the parent tail with the variant's mapped
 * output; the artifact this records is the PARENT continuation — the run
 * whose final state the scenario's assertions judge — with the child
 * variant's identity in `meta.forkChild`. Usage sums both halves, since the
 * substituted subgraph node carries no token accounting of its own.
 */
async function forkChildOfRecordedRun(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  baseRunId: string,
  options: ForkRecordedOptions,
  at: { beforeNode: string; occurrence?: number | 'last' },
): Promise<ForkOutcome> {
  const { built, agents, runner, authoredGraph } = await rewire(scenario, params, stack, baseRunId);
  const closureLoad = (runner as { loadGraph?: (id: string) => Promise<Graph | null> }).loadGraph;
  if (!closureLoad) {
    throw new Error(
      `forking inside '${at.beforeNode}' needs the scenario's child graphs, and '${scenario.id}' embeds none`,
    );
  }

  // The recorded graph names the child by the id minted at RECORD time; the
  // rebuild's closure keys its children by the ids minted just now. Node ids
  // are stable across builds, so the subgraph node's two references pair the
  // recorded id with the authored one.
  const subgraphNodeId = at.beforeNode.slice(0, at.beforeNode.indexOf('/'));
  const recordedChildId = built.graph.nodes.find((n) => n.id === subgraphNodeId)?.subgraph_config?.subgraph_id;
  const authoredChildId = authoredGraph.nodes.find((n) => n.id === subgraphNodeId)?.subgraph_config?.subgraph_id;
  const loadGraph = async (id: string): Promise<Graph | null> => {
    if (id === recordedChildId && authoredChildId) return closureLoad(authoredChildId);
    return closureLoad(id);
  };

  const runId = randomUUID();
  const childVariantRunId = randomUUID();
  const recorder = await RunRecorder.open(stack.config.artifactRoot, {
    runId,
    scenarioId: scenario.id,
    params,
    stack: stack.config,
    parentRunId: baseRunId,
  });

  const enteredAt = new Map<string, number>();
  const progress: GraphRunnerMiddleware = {
    async beforeNodeExecute(ctx) {
      options.onNode?.(ctx.node.id, 'start');
      enteredAt.set(ctx.node.id, Date.now());
      await recorder.event({
        type: 'node:start',
        node_id: ctx.node.id,
        node_type: ctx.node.type,
        iteration: ctx.iteration,
        timestamp: Date.now(),
      } as never);
    },
    async afterReduce(ctx) {
      options.onNode?.(ctx.node.id, 'done');
      const started = enteredAt.get(ctx.node.id);
      await recorder.event({
        type: 'node:complete',
        node_id: ctx.node.id,
        node_type: ctx.node.type,
        ...(started === undefined ? {} : { duration_ms: Date.now() - started }),
        timestamp: Date.now(),
      } as never);
    },
  };

  const started = Date.now();
  const result = await forkInChild(baseRunId, {
    at,
    ...(options.change ? { change: options.change } : {}),
    eventLog: stack.eventLog,
    graph: built.graph,
    registry: agents,
    loadGraph,
    runner: {
      ...runner,
      middleware: [...(runner.middleware ?? []), progress],
      logger: (entry) => recorder.log(entry),
    },
    ...(options.memoize || options.allow?.length
      ? {
        policy: {
          ...(options.memoize ? { memoize: true } : {}),
          ...(options.allow?.length ? { sideEffects: { allow: options.allow } } : {}),
        },
      }
      : {}),
    ...(options.hitl ?? built.hitl ? { hitl: (options.hitl ?? built.hitl)! } : {}),
    runId,
    childVariantRunId,
  });

  const { child, parent } = result;
  const parentState = parent?.state ?? null;
  await recorder.amendMeta({
    forkSequenceId: parent?.forkSequenceId ?? child.forkSequenceId,
    forkChanges: child.changes,
    forkMemoized: options.memoize === true,
    forkChild: {
      subgraphNodeId: result.subgraphNodeId,
      childBaseRunId: result.childBaseRunId,
      childVariantRunId,
      childStatus: child.state?.status ?? 'unknown',
      ...(result.parentSkipped ? { parentSkipped: result.parentSkipped } : {}),
    },
  });

  // Usage spans both halves: the parent tail excludes the substituted
  // subgraph node entirely, and the child variant carries exactly that
  // node's real spend, so the sum double-counts nothing.
  const childTokens = child.state?.total_tokens_used ?? 0;
  const childCost = child.state?.total_cost_usd ?? 0;
  if (parentState) {
    await recorder.snapshot(parentState);
    await recorder.writeUsage({
      totalTokens: parentState.total_tokens_used + childTokens,
      totalCostUsd: parentState.total_cost_usd + childCost,
      nodesVisited: parentState.visited_nodes.length + (child.state?.visited_nodes.length ?? 0),
    });
  } else if (child.state) {
    await recorder.snapshot(child.state);
    await recorder.writeUsage({
      totalTokens: childTokens,
      totalCostUsd: childCost,
      nodesVisited: child.state.visited_nodes.length,
    });
  }

  const evals = parentState
    ? await runEvals(scenario, params as never, stack, parentState)
    : [];
  const judged = parentState && parent
    ? {
      base: { status: parent.baseState.status, evals: await runEvals(scenario, params as never, stack, parent.baseState), costUsd: parent.baseState.total_cost_usd },
      variant: { status: parentState.status, evals, costUsd: parentState.total_cost_usd, changedKeys: Object.keys(parent.diff?.memory ?? {}) },
    }
    : {
      base: { status: child.baseState.status, evals: [], costUsd: child.baseState.total_cost_usd },
      variant: { status: child.state?.status ?? 'unknown', evals: [], costUsd: child.state?.total_cost_usd ?? 0, changedKeys: Object.keys(child.diff?.memory ?? {}) },
    };
  const verdict = judgeFork(judged.base, judged.variant, { scenarioId: scenario.id });

  const status = parentState?.status ?? child.state?.status ?? 'unknown';
  const durationMs = Date.now() - started;
  await recorder.writeEvals(evals);
  await recorder.close({ status, durationMs });

  const report = [
    `child fork (${result.subgraphNodeId}): ${child.explain()}`,
    parent ? `parent continuation: ${parent.explain()}` : `parent continuation skipped: ${result.parentSkipped}`,
  ].join('\n\n');

  return {
    runId,
    baseRunId,
    dir: recorder.dir,
    durationMs,
    status,
    report,
    incurredCostUsd: child.incurredCostUsd + (parent?.incurredCostUsd ?? 0),
    memoized: child.memoHits.length + (parent?.memoHits.length ?? 0),
    forkSequenceId: parent?.forkSequenceId ?? child.forkSequenceId,
    forkNodeId: at.beforeNode,
    ...(parent?.diff ? { diff: parent.diff } : {}),
    memoHits: [
      ...child.memoHits.map((h) => `${result.subgraphNodeId}/${h.nodeId}`),
      ...(parent?.memoHits.map((h) => h.nodeId) ?? []),
    ],
    suppressed: [
      ...child.suppressedEffects.map((e) => ({ ...e, nodeId: `${result.subgraphNodeId}/${e.nodeId}` })),
      ...(parent?.suppressedEffects ?? []),
    ],
    evals,
    verdict,
  };
}

/** Fork one recorded run of a scenario. */
export async function forkRecordedRun(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  baseRunId: string,
  options: {
    at?: ForkPoint;
    change?: Change | Change[];
    memoize?: boolean;
    /** Node ids allowed to perform their real side effects. */
    allow?: string[];
    /** Reports the tail's progress, so a caller can show it unfolding. */
    onNode?: (nodeId: string, phase: 'start' | 'done') => void;
    /** Answers a gate the tail reaches. */
    hitl?: (question: string) => Promise<HumanResponse>;
  },
): Promise<ForkOutcome> {
  // A namespaced address diverges inside a subgraph child, which is a
  // different composition: the child variant plus the parent continuation.
  const at = options.at;
  if (at && typeof at === 'object' && 'beforeNode' in at && at.beforeNode.includes('/')) {
    return forkChildOfRecordedRun(scenario, params, stack, baseRunId, options, at);
  }

  const { built, agents, runner } = await rewire(scenario, params, stack, baseRunId);

  // `fork()` drives `run()` rather than `stream()`, so node lifecycle arrives
  // through the middleware seam the fork already merges rather than a second
  // event channel.
  // `fork()` drives `run()`, which does not yield the stream a scenario run
  // records. The middleware seam reconstructs the node lifecycle, so a fork's
  // artifact carries the same shape of event rather than none at all.
  // Entered-at per node, so a completion can report what the node cost. A
  // `node:complete` without `duration_ms` reads downstream as a node that took
  // no time, which makes a fork look free next to the run it forked.
  const enteredAt = new Map<string, number>();

  const progress: GraphRunnerMiddleware = {
    async beforeNodeExecute(ctx) {
      options.onNode?.(ctx.node.id, 'start');
      enteredAt.set(ctx.node.id, Date.now());
      await recorder.event({
        type: 'node:start',
        node_id: ctx.node.id,
        node_type: ctx.node.type,
        iteration: ctx.iteration,
        timestamp: Date.now(),
      } as never);
    },
    async afterReduce(ctx) {
      options.onNode?.(ctx.node.id, 'done');
      const started = enteredAt.get(ctx.node.id);
      await recorder.event({
        type: 'node:complete',
        node_id: ctx.node.id,
        node_type: ctx.node.type,
        ...(started === undefined ? {} : { duration_ms: Date.now() - started }),
        timestamp: Date.now(),
      } as never);
    },
  };

  // The recorder opens BEFORE the fork so the tail's logs land in it. Opening
  // after — which is what an id minted inside fork() would force — leaves
  // `logs.ndjson` and `events.ndjson` present and empty, which reads as
  // "nothing happened" rather than "not captured".
  const runId = randomUUID();
  const recorder = await RunRecorder.open(stack.config.artifactRoot, {
    runId,
    scenarioId: scenario.id,
    params,
    stack: stack.config,
    parentRunId: baseRunId,
  });

  // The trace the base run was recorded under, so the fork's span points back
  // at it. Read from the base's artifact rather than threaded through the
  // caller, because the recorder is where a run's trace id is written down.
  const baseTraceId = (await findRun(stack.config.artifactRoot, baseRunId))?.meta.traceId;

  const started = Date.now();
  const result = await fork(baseRunId, {
    runId,
    ...(baseTraceId ? { baseTraceId } : {}),
    ...(options.at ? { at: options.at } : {}),
    ...(options.change ? { change: options.change } : {}),
    eventLog: stack.eventLog,
    persistence: stack.persistence,
    graph: built.graph,
    registry: agents,
    ...(options.memoize || options.allow?.length
      ? {
        policy: {
          ...(options.memoize ? { memoize: true } : {}),
          ...(options.allow?.length ? { sideEffects: { allow: options.allow } } : {}),
        },
      }
      : {}),
    // A reviewer who is present outranks the scenario's script, the same
    // precedence `executeScenario` applies.
    ...(options.hitl ?? built.hitl ? { hitl: (options.hitl ?? built.hitl)! } : {}),
    runner: {
      ...runner,
      middleware: [...(runner.middleware ?? []), progress],
      // The tail's structured logs go to this fork's artifact, the same place
      // an ordinary run's do.
      logger: (entry) => recorder.log(entry),
    },
  });

  // Where the fork diverged is only known once it has resolved, so the meta
  // written at open() is completed here.
  await recorder.amendMeta({
    forkSequenceId: result.forkSequenceId,
    forkChanges: result.changes,
    forkMemoized: options.memoize === true,
  });
  if (result.state) {
    await recorder.snapshot(result.state);
    await recorder.writeUsage({
      totalTokens: result.state.total_tokens_used,
      totalCostUsd: result.incurredCostUsd,
      nodesVisited: result.state.visited_nodes.length,
      ...(Object.keys(result.state.node_breakdown ?? {}).length > 0
        ? { byNode: result.state.node_breakdown }
        : {}),
    });
  }
  // The scenario's own assertions, checked against BOTH sides. Re-checking the
  // base rather than reading its recorded verdict keeps the comparison fair:
  // the same assertions, the same code path, one run apart.
  const evals = result.state
    ? await runEvals(scenario, params as never, stack, result.state)
    : [];
  const baseEvals = await runEvals(scenario, params as never, stack, result.baseState);

  const verdict = judgeFork(
    {
      status: result.baseState.status,
      evals: baseEvals,
      costUsd: result.baseState.total_cost_usd,
    },
    {
      status: result.state?.status ?? 'unknown',
      evals,
      costUsd: result.state?.total_cost_usd ?? 0,
      changedKeys: Object.keys(result.diff?.memory ?? {}),
    },
    { scenarioId: scenario.id },
  );

  const durationMs = Date.now() - started;
  await recorder.writeEvals(evals);
  await recorder.close({ status: result.state?.status ?? 'unknown', durationMs });

  return {
    runId: result.runId,
    baseRunId,
    dir: recorder.dir,
    durationMs,
    status: result.state?.status ?? 'unknown',
    report: result.explain(),
    incurredCostUsd: result.incurredCostUsd,
    memoized: result.memoHits.length,
    forkSequenceId: result.forkSequenceId,
    ...(result.forkNodeId ? { forkNodeId: result.forkNodeId } : {}),
    ...(result.diff ? { diff: result.diff } : {}),
    memoHits: result.memoHits.map((h) => h.nodeId),
    suppressed: result.suppressedEffects,
    evals,
    verdict,
  };
}

/** Everything two states must agree on for a null fork to be faithful. */
function compare(base: WorkflowState, variant: WorkflowState): string | undefined {
  if (base.status !== variant.status) {
    return `status ${variant.status}, base ${base.status}`;
  }
  if (base.visited_nodes.join('>') !== variant.visited_nodes.join('>')) {
    return `path ${variant.visited_nodes.join('→')}, base ${base.visited_nodes.join('→')}`;
  }
  // Canonical, per key. Two things make a plain stringify wrong here: memory
  // key insertion order differs between a run and a fork of it, and a value
  // that came back out of jsonb has its own object keys reordered. Neither is
  // a difference in what the run produced.
  const keys = new Set([...Object.keys(base.memory), ...Object.keys(variant.memory)]);
  const differing = [...keys].filter(
    k => !canonicalEquals(base.memory[k], variant.memory[k]),
  );
  if (differing.length > 0) return `memory differs at ${differing.join(', ')}`;
  if (base.iteration_count !== variant.iteration_count) {
    return `iteration ${variant.iteration_count}, base ${base.iteration_count}`;
  }
  return undefined;
}

/**
 * Fork a recorded run at every point it exposes, changing nothing.
 *
 * A fork that changes nothing must land exactly where the original did. Any
 * point where it does not is a replay bug: either the prefix was reconstructed
 * wrongly, or the tail's recorded outputs were matched to the wrong inputs.
 *
 * Runs on recorded outputs throughout, so the whole sweep is free.
 */
export async function checkForkConformance(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  base: { runId: string; finalState: WorkflowState },
): Promise<ConformanceResult> {
  const { built, agents, runner } = await rewire(scenario, params, stack, base.runId);
  const events = await stack.eventLog.loadEvents(base.runId);
  const points = forkPoints(events);

  const entries: ConformanceEntry[] = [];
  const errors: Array<{ point: string; message: string }> = [];

  for (const point of points) {
    const label = `${point.nodeId}#${point.occurrence}`;
    try {
      const result: ForkResult = await fork(base.runId, {
        at: { sequence: point.sequenceId },
        eventLog: stack.eventLog,
        graph: built.graph,
        registry: agents,
        runner,
        // The scenario's own reviewer, not a change: the base run answered its
        // gates this way, so a fork that pauses instead is not comparable.
        ...(built.hitl ? { hitl: built.hitl } : {}),
        // No change, so every tail node's inputs match the recording and the
        // whole tail is served from it. Zero model calls.
        policy: { memoize: true },
        // A null fork re-runs nothing, so nothing can reach the world; the
        // recorded results are the only ones in play either way.
        ignoreBudget: true,
      });

      const divergence = result.state
        ? compare(base.finalState, result.state)
        : 'no final state';

      entries.push({
        point: label,
        nodeId: point.nodeId,
        sequence: point.sequenceId,
        faithful: divergence === undefined,
        ...(divergence ? { divergence } : {}),
      });
    } catch (error) {
      errors.push({ point: label, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    scenarioId: scenario.id,
    baseRunId: base.runId,
    baseStatus: base.finalState.status,
    entries,
    faithful: entries.filter(e => e.faithful).length,
    errors,
  };
}

/**
 * What a set of variants will spend against one base run, without running any
 * of them.
 *
 * Wraps the engine's `estimateSweep`, which resolves every variant as a dry
 * fork. That is the part worth having here: a change that will not resolve
 * against the graph is reported now rather than after the earlier variants
 * have already been paid for. The dollar figure is honest and, on a corpus of
 * local models with no pricing, zero.
 */
export async function estimateForkSweep(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  baseRunId: string,
  variants: Record<string, Change[]>,
  at: ForkPoint,
): Promise<{ costUsd: number; lines: string[] }> {
  const { built, agents, runner } = await rewire(scenario, params, stack, baseRunId);

  return estimateSweep(baseRunId, {
    at,
    variants,
    eventLog: stack.eventLog,
    persistence: stack.persistence,
    graph: built.graph,
    registry: agents,
    runner,
  });
}

/**
 * The system prompt behind one node's agent, as the scenario authors it.
 *
 * Read through a rebuild rather than any recorded run, because the prompt in
 * question is the one a rewrite would replace: what the graph says today, not
 * what some run happened to execute with.
 */
export async function resolveAgentPrompt(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  nodeId: string,
): Promise<string | undefined> {
  const { built, agents } = await rewire(scenario, params, stack);
  const node = built.graph.nodes.find((n) => n.id === nodeId);
  if (!node?.agent_id) return undefined;
  return (await agents.loadAgent(node.agent_id))?.system_prompt;
}

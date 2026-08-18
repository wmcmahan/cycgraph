/**
 * Named-signal detection
 *
 * The engine already names what went wrong. Around ninety distinct `warn` and
 * `error` events carry a stable name and a structured context, so finding them
 * needs counting, not a language model. Everything a model could add here it
 * could also invent.
 *
 * A signal becomes a finding when it recurs: one `node_retry` is a run having
 * a bad afternoon, and the same node retrying across a third of runs is a
 * property of the graph.
 *
 * @module insights/signals
 */

import type { Detector, Finding, FindingSeverity, RunTelemetry } from './types.js';
import { seenAt, startTimes } from './recency.js';

/** What a known signal means, and what a change would have to address. */
interface SignalSpec {
  severity: FindingSeverity;
  /** Present tense, naming the behaviour rather than a remedy. */
  title: string;
  addresses: string;
  /**
   * Occurrences that are the design rather than a defect, read from the
   * context the engine logged alongside the signal.
   */
  ignore?: (context: Record<string, unknown> | undefined) => boolean;
}

/**
 * The signals worth reporting, keyed by the suffix of the event name.
 *
 * Keyed on the suffix rather than the full dotted name because the same
 * condition is emitted from several components — `no_matching_edge` comes from
 * both the router node and the graph runner — and they are one finding.
 *
 * Absent from this table is not "unimportant": it is "not yet known to be
 * actionable". An unlisted signal is counted and reported at low severity
 * rather than silently dropped, so a new engine warning surfaces here the
 * first time it fires instead of waiting for someone to extend the table.
 */
const KNOWN: Record<string, SignalSpec> = {
  max_iterations_reached: {
    severity: 'high',
    title: 'hits its iteration cap',
    addresses: 'the loop does not converge before the cap, so the run ends by exhaustion rather than completion',
    // A cap of one has no headroom to not exhaust, so reaching it is the
    // single delegation the author asked for, not a failure to converge.
    ignore: (context) => typeof context?.['max'] === 'number' && context['max'] <= 1,
  },
  no_matching_edge: {
    severity: 'high',
    title: 'reaches a dead end with no matching edge',
    addresses: 'routing leaves the run nowhere to go, which is an authoring gap rather than a model failure',
  },
  node_error_non_retryable: {
    severity: 'high',
    title: 'fails without retrying',
    addresses: 'the node raised an error its failure policy treats as permanent',
  },
  unauthorized_key_write: {
    severity: 'high',
    title: 'tries to write memory it has no grant for',
    addresses: 'declared write keys and what the agent actually produces disagree',
  },
  node_budget_exceeded: {
    severity: 'high',
    title: 'breaches its per-node budget',
    addresses: 'the node costs more than its cap allows, so it is stopped rather than completed',
  },
  tainted_condition_rejected: {
    severity: 'high',
    title: 'routes on tainted data and is rejected',
    addresses: 'an edge condition reads untrusted content, which strict taint mode refuses',
  },
  mcp_tool_allowlist_absent: {
    severity: 'medium',
    title: 'connects to an MCP server with no tool allowlist',
    addresses: 'every tool the server offers is reachable, so the surface is whatever the server decides',
  },
  node_retry: {
    severity: 'medium',
    title: 'retries',
    addresses: 'the node fails transiently often enough to be worth looking at',
  },
  a2a_task_not_completed: {
    severity: 'medium',
    title: 'leaves its remote task unfinished',
    addresses: 'the remote agent did not reach a terminal state within this run',
  },
  graph_validation_warnings: {
    severity: 'medium',
    title: 'is authored with validation warnings',
    addresses: 'the graph validator flagged the authoring before the run started',
  },
  unknown_model_pricing: {
    severity: 'low',
    title: 'runs a model with no pricing entry',
    addresses: 'spend cannot be attributed for this model, so cost reporting and budgets under-count',
  },
  swarm_max_handoffs: {
    severity: 'medium',
    title: 'exhausts its handoff budget',
    addresses: 'peers pass work between themselves without converging',
  },
  memory_dropped: {
    severity: 'medium',
    title: 'has memory writes dropped',
    addresses: 'a node wrote keys the blackboard refused, so its output is silently incomplete',
  },
};

/** How often a signal must recur before it is a property rather than an incident. */
const MIN_RUNS = 2;

/** Runs that met or missed their assertions before co-occurrence means anything. */
const MIN_EVIDENCE = 2;

/** How many run ids a finding carries, which is enough to fork from. */
const SAMPLE_LIMIT = 5;

/** The last dotted segment, which is the signal name the engine chose. */
function signalName(event: string): string {
  const parts = event.split('.');
  return parts[parts.length - 1] ?? event;
}

/** The node a log line is about, when it names one. */
function nodeOf(context: Record<string, unknown> | undefined): string | undefined {
  const id = context?.['node_id'];
  return typeof id === 'string' ? id : undefined;
}

/** Whether a run did what its assertions claimed. Unclassifiable without them. */
function verdictOf(run: RunTelemetry): 'clean' | 'failing' | undefined {
  if (run.assertions.length === 0) return undefined;
  return run.assertions.every(a => a.passed) ? 'clean' : 'failing';
}

/** One workflow's signal, on one node, across the corpus. */
interface SignalGroup {
  workflow: string;
  signal: string;
  nodeId?: string;
  occurrences: number;
  runIds: Set<string>;
  /** Runs carrying it that met every assertion. */
  clean: Set<string>;
  /** Runs carrying it that missed one. */
  failing: Set<string>;
}

/** Severity moved one step, since the steps are the whole scale. */
function demote(severity: FindingSeverity): FindingSeverity {
  return severity === 'high' ? 'medium' : 'low';
}

/**
 * Rank a signal by what it has actually coincided with.
 *
 * The table says what a signal means in general. The corpus says what it has
 * meant here, and where they disagree the corpus wins: a warning that has
 * never once accompanied a run missing its assertions is the workflow behaving
 * as its author specified, whatever the table calls it, and a warning that has
 * only ever accompanied one is the most actionable thing in the report even
 * when nothing has named it yet.
 */
function weigh(group: SignalGroup, base: FindingSeverity): { severity: FindingSeverity; note?: string } {
  if (group.failing.size === 0 && group.clean.size >= MIN_EVIDENCE) {
    return {
      severity: demote(base),
      note: `never seen in a run that missed its assertions (${group.clean.size} clean)`,
    };
  }

  if (group.clean.size === 0 && group.failing.size >= MIN_EVIDENCE) {
    return {
      severity: 'high',
      note: `only ever seen in runs that missed their assertions (${group.failing.size})`,
    };
  }

  return { severity: base };
}

/**
 * Signals that recur across workflows but never twice within one.
 *
 * Grouping by workflow is what makes a finding actionable, and it is also what
 * hides a signal that fires once in each of six scenarios. That shape is the
 * most informative one there is — it says the cause is the engine rather than
 * any one graph — so it gets its own pass rather than being lost to a
 * threshold meant for a different question.
 */
function spanningFindings(
  groups: Iterable<SignalGroup>,
  reported: ReadonlySet<string>,
  totalRuns: number,
  times: ReadonlyMap<string, string>,
): Finding[] {
  const bySignal = new Map<string, SignalGroup[]>();
  for (const group of groups) {
    if (reported.has(group.signal)) continue;
    const list = bySignal.get(group.signal) ?? [];
    list.push(group);
    bySignal.set(group.signal, list);
  }

  const findings: Finding[] = [];
  for (const [signal, list] of bySignal) {
    const workflows = new Set(list.map(g => g.workflow));
    if (workflows.size < MIN_RUNS) continue;

    const merged: SignalGroup = {
      workflow: '*',
      signal,
      occurrences: list.reduce((sum, g) => sum + g.occurrences, 0),
      runIds: new Set(list.flatMap(g => [...g.runIds])),
      clean: new Set(list.flatMap(g => [...g.clean])),
      failing: new Set(list.flatMap(g => [...g.failing])),
    };

    const spec = KNOWN[signal];
    const { severity, note } = weigh(merged, spec?.severity ?? 'low');

    findings.push({
      id: `signal:*:${signal}:-`,
      detector: 'signals',
      severity,
      workflow: '*',
      title: spec ? `every workflow ${spec.title}` : `'${signal}' spans workflows`,
      detail: [
        `${merged.runIds.size} run(s) across ${workflows.size} workflows, once each`,
        ...(note ? [note] : []),
      ].join(' — '),
      evidence: {
        runs: merged.runIds.size,
        occurrences: merged.occurrences,
        sampleRunIds: [...merged.runIds].slice(0, SAMPLE_LIMIT),
        of: totalRuns,
        ...seenAt(merged.runIds, times),
      },
      addresses: spec?.addresses
        ?? `'${signal}' fires in unrelated workflows, so whatever causes it is beneath all of them rather than in any one graph`,
    });
  }

  return findings;
}


/**
 * Report named `warn`/`error` signals that recur across runs.
 *
 * Grouped by workflow, signal, and node: the same warning on two different
 * nodes is two findings, because a change addresses one of them.
 */
export const detectSignals: Detector = (runs: readonly RunTelemetry[]): Finding[] => {
  const groups = new Map<string, SignalGroup>();
  const runsPerWorkflow = new Map<string, number>();
  const times = startTimes(runs);

  for (const run of runs) {
    runsPerWorkflow.set(run.workflow, (runsPerWorkflow.get(run.workflow) ?? 0) + 1);
    const verdict = verdictOf(run);

    for (const line of run.logs) {
      if (line.level !== 'warn' && line.level !== 'error') continue;

      const signal = signalName(line.event);
      if (KNOWN[signal]?.ignore?.(line.context)) continue;

      const nodeId = nodeOf(line.context);
      const key = `${run.workflow} ${signal} ${nodeId ?? ''}`;

      const group = groups.get(key) ?? {
        workflow: run.workflow,
        signal,
        ...(nodeId ? { nodeId } : {}),
        occurrences: 0,
        runIds: new Set<string>(),
        clean: new Set<string>(),
        failing: new Set<string>(),
      };
      group.occurrences++;
      group.runIds.add(run.runId);
      if (verdict) group[verdict].add(run.runId);
      groups.set(key, group);
    }
  }

  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const group of groups.values()) {
    if (group.runIds.size < MIN_RUNS) continue;
    reported.add(group.signal);

    const spec = KNOWN[group.signal];
    const subject = group.nodeId ? `'${group.nodeId}'` : group.workflow;
    const of = runsPerWorkflow.get(group.workflow) ?? runs.length;
    const { severity, note } = weigh(group, spec?.severity ?? 'low');

    findings.push({
      id: `signal:${group.workflow}:${group.signal}:${group.nodeId ?? '-'}`,
      detector: 'signals',
      severity,
      workflow: group.workflow,
      ...(group.nodeId ? { nodeId: group.nodeId } : {}),
      title: spec ? `${subject} ${spec.title}` : `${subject} emits '${group.signal}'`,
      detail: [
        `${group.runIds.size} of ${of} runs, ${group.occurrences} occurrence(s)`,
        ...(note ? [note] : []),
      ].join(' — '),
      evidence: {
        runs: group.runIds.size,
        occurrences: group.occurrences,
        sampleRunIds: [...group.runIds].slice(0, SAMPLE_LIMIT),
        of,
        ...seenAt(group.runIds, times),
      },
      // An unnamed signal is still reported, with the honest admission that
      // nothing here knows what it means yet.
      addresses: spec?.addresses
        ?? `the engine emits '${group.signal}' here and this detector has no interpretation for it yet`,
    });
  }

  return [...findings, ...spanningFindings(groups.values(), reported, runs.length, times)];
};

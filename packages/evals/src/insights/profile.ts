/**
 * Workflow profile
 *
 * Where one workflow spends itself, node by node. Not a finding and not a
 * defect test: nothing here is wrong, and no threshold decides what appears.
 * Every node the workflow executed is listed, in the order that matters for
 * optimising it.
 *
 * The distinction from a detector is the useful part. Asking whether a node is
 * an outlier against its siblings has no good answer, because a supervisor and
 * an agent are not doing the same job and no grouping makes them comparable.
 * Asking where the time goes has an exact answer, and it is the one someone
 * optimising the workflow actually needs.
 *
 * **The contribution is split into cost per visit and visit count**, because
 * they are different levers and a share alone hides which one to pull. A
 * supervisor at two thirds of a workflow's execution time can be a slow prompt
 * or a loop that iterates four times, and those have nothing to do with each
 * other.
 *
 * @module insights/profile
 */

import type { RunTelemetry } from './types.js';

/** What one node contributed to its workflow. */
export interface NodeProfile {
  nodeId: string;
  /** Node type, which is what it is rather than how it performed. */
  type: string;
  /** Execution time attributed to it, as a fraction of the workflow's total. */
  timeShare: number;
  /** Mean execution time it added to a run. */
  msPerRun: number;
  /** Mean execution time of one visit, which a prompt or model change moves. */
  msPerVisit: number;
  /** Mean visits per run, which an iteration or routing change moves. */
  visitsPerRun: number;
  /** Mean tokens per call, or undefined when nothing attributed spend to it. */
  tokensPerCall?: number;
  /**
   * Sampling temperatures observed across the node's calls.
   *
   * A range rather than a mean, because scheduled nodes vary it by design and
   * a mean of an annealing schedule describes no call that was made. Equal
   * ends mean a fixed temperature. Absent on runs recorded before calls
   * logged what they sampled at.
   */
  temperature?: { min: number; max: number };
  /** Its token spend as a fraction of the workflow's total. */
  tokenShare?: number;
}

/** Where a workflow spends itself. */
export interface WorkflowProfile {
  workflow: string;
  /** Runs the profile was built from. */
  runs: number;
  /**
   * Every model the runs were made against.
   *
   * More than one means the numbers pool populations that are not comparable,
   * the same way a duration median over two models describes neither. Carried
   * rather than silently filtered, because the caller knows whether it wanted
   * the aggregate and this is what lets it say so.
   */
  models: string[];
  /** Mean execution time of a run. */
  msPerRun: number;
  /** Mean tokens per run. */
  tokensPerRun: number;
  /** Every node executed, most expensive in time first. */
  nodes: NodeProfile[];
}

/** Running totals for one node across the runs it appeared in. */
interface NodeTotals {
  type: string;
  ms: number;
  visits: number;
  tokens: number;
  calls: number;
  temperatures: number[];
}

/**
 * Build a profile of one workflow from its recorded runs.
 *
 * Runs of other workflows are ignored rather than rejected, so a caller can
 * pass the whole corpus. Everything is a mean per run, so a node appearing in
 * more runs does not read as more expensive for that reason alone.
 */
export function buildWorkflowProfile(
  workflow: string,
  corpus: readonly RunTelemetry[],
): WorkflowProfile | undefined {
  const runs = corpus.filter(run => run.workflow === workflow);
  if (runs.length === 0) return undefined;

  const totals = new Map<string, NodeTotals>();
  const seed = (nodeId: string, type: string): NodeTotals => {
    const entry = totals.get(nodeId) ?? { type, ms: 0, visits: 0, tokens: 0, calls: 0, temperatures: [] };
    if (entry.type === 'unknown') entry.type = type;
    totals.set(nodeId, entry);
    return entry;
  };

  for (const run of runs) {
    for (const [nodeId, timing] of Object.entries(run.nodeTiming ?? {})) {
      const entry = seed(nodeId, timing.type);
      entry.ms += timing.total_ms;
      entry.visits += timing.visits;
    }
    for (const [nodeId, usage] of Object.entries(run.byNode ?? {})) {
      const entry = seed(nodeId, 'unknown');
      entry.tokens += usage.input_tokens + usage.output_tokens;
      entry.calls += usage.calls;
    }

    // What each call sampled at, from the execution log lines. The engine
    // logs it per call because a scheduled node varies it per iteration,
    // which no aggregate anywhere else can reconstruct.
    for (const line of run.logs) {
      if (!line.event.endsWith('.executing') && !line.event.endsWith('.routing')) continue;
      const nodeId = line.context?.['node_id'];
      const temperature = line.context?.['temperature'];
      if (typeof nodeId !== 'string' || typeof temperature !== 'number') continue;
      seed(nodeId, 'unknown').temperatures.push(temperature);
    }
  }

  if (totals.size === 0) return undefined;

  const totalMs = [...totals.values()].reduce((sum, e) => sum + e.ms, 0);
  const totalTokens = [...totals.values()].reduce((sum, e) => sum + e.tokens, 0);

  const nodes: NodeProfile[] = [...totals].map(([nodeId, entry]) => ({
    nodeId,
    type: entry.type,
    timeShare: totalMs === 0 ? 0 : entry.ms / totalMs,
    msPerRun: entry.ms / runs.length,
    msPerVisit: entry.visits === 0 ? 0 : entry.ms / entry.visits,
    visitsPerRun: entry.visits / runs.length,
    ...(entry.calls > 0 ? { tokensPerCall: entry.tokens / entry.calls } : {}),
    ...(entry.temperatures.length > 0
      ? { temperature: { min: Math.min(...entry.temperatures), max: Math.max(...entry.temperatures) } }
      : {}),
    ...(totalTokens > 0 ? { tokenShare: entry.tokens / totalTokens } : {}),
  }));

  // Most expensive in time first, since that is what the profile is read for.
  // Node id breaks ties so two profiles of one corpus can be diffed.
  nodes.sort((a, b) => b.msPerRun - a.msPerRun || (a.nodeId < b.nodeId ? -1 : 1));

  return {
    workflow,
    runs: runs.length,
    models: [...new Set(runs.map(run => run.model).filter((m): m is string => m !== undefined))].sort(),
    msPerRun: totalMs / runs.length,
    tokensPerRun: totalTokens / runs.length,
    nodes,
  };
}

/**
 * The lever most likely to move a node's contribution.
 *
 * A node visited more than once is dominated by how often it runs rather than
 * by what one run of it costs, and those are addressed by different changes.
 * Phrased as what to try rather than what is wrong, because nothing here is
 * wrong.
 */
export function describeLever(node: NodeProfile): string {
  if (node.visitsPerRun > 1.5) {
    return `visited ${node.visitsPerRun.toFixed(1)} times a run, so the iteration or routing budget moves this more than the prompt does`;
  }
  return 'visited about once a run, so its prompt, model, or context budget is the lever';
}

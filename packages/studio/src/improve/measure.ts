/**
 * The measure graph: sweep arms as fan-out
 *
 * One arm — a variant's changes forked from one base run — is a procedure
 * from the graph's point of view, even though it runs a workflow tail
 * inside; so a `fork_arm` tool wraps `forkRecordedRun`, and a map node fans
 * out over every arm a pass needs. Arms arrive through memory: the graph
 * reads them from `plan.arms`, which is what lets a tune parent embed this
 * as a subgraph and feed each cycle's batch through its input mapping. What
 * the graph buys over a driver loop: arms run in parallel under an explicit
 * concurrency cap, and the fan-out is part of whichever run embeds it —
 * traceable and, under a recorded parent, durable.
 *
 * Draw pooling stays outside, in the planner, as a cache: the graph is
 * handed only the arms that need fresh draws, so the memo table never
 * becomes load-bearing control flow. An arm that fails becomes an outcome
 * carrying its error rather than failing the fan-out, because a candidate
 * the engine refuses is a result about that candidate.
 *
 * @module improve/measure
 */

import { z } from 'zod';
import { graph, mapReduce, node, tool } from '@cycgraph/orchestrator';
import type { Change, ForkPoint } from '@cycgraph/orchestrator';
import { computeMs } from '@cycgraph/evals';
import type { VariantOutcome } from '@cycgraph/evals';
import { forkRecordedRun } from '../run/fork.js';
import { findRun } from '../run/history.js';
import { toTelemetry } from '../run/insights.js';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';

/**
 * Arms forked at once.
 *
 * Conservative because a local model server queues concurrent tails rather
 * than running them, so raising this buys contention before it buys speed.
 */
const DEFAULT_CONCURRENCY = 2;

/** Where the fan-out writes its wrappers and errors. */
export const MEASURE_RESULTS_KEY = 'measure_results';
export const MEASURE_ERRORS_KEY = 'measure_errors';

/** The memory key the graph reads its batch from. */
export const MEASURE_PLAN_KEY = 'plan';

/** One fork a pass needs: a variant's changes taken from one base run. */
export interface MeasureArm {
  /** The key from `KnobSweep.variants` the outcome reports under. */
  variant: string;
  baseRunId: string;
  at: ForkPoint;
  changes: Change[];
  /** Progress line reported when the arm starts. */
  label?: string;
}

/** Options for {@link buildMeasureGraph}. */
export interface MeasureOptions {
  /** Arms in flight at once. @default 2 */
  concurrency?: number;
  /** Reports each arm as it starts. */
  onProgress?: (message: string) => void;
}

/** What a finished fork looks like to the decision rules. */
async function outcomeOf(
  stack: Stack,
  arm: MeasureArm,
  forkRunId: string,
  evals: ReadonlyArray<{ assertion: { type: string }; passed: boolean }>,
): Promise<VariantOutcome> {
  const entry = await findRun(stack.config.artifactRoot, forkRunId);
  const telemetry = entry ? await toTelemetry(entry) : undefined;
  const failed = evals.filter((result) => !result.passed);
  return {
    name: arm.variant,
    runId: forkRunId,
    // A fork that checked no assertions has established nothing, so it does
    // not count as holding them.
    assertionsHeld: evals.length > 0 && failed.length === 0,
    failed: failed.map((result) => result.assertion.type),
    computeMs: (telemetry ? computeMs(telemetry) : 0) ?? 0,
    tokens: telemetry?.totalTokens ?? 0,
  };
}

/** An arm the engine refused, as a result about that arm. */
function errorOutcome(variant: string, err: unknown): VariantOutcome {
  return {
    name: variant,
    assertionsHeld: false,
    failed: [],
    computeMs: 0,
    tokens: 0,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Reassemble the fan-out's wrappers into one outcome per arm, in arm order.
 *
 * The map node stores worker results as `{ index, updates }` wrappers and
 * failures separately, so the pass is put back together by index. An arm the
 * fan-out lost entirely still gets an outcome, because a silently missing
 * draw would read downstream as a sample that never existed.
 */
export function assembleOutcomes(
  arms: readonly MeasureArm[],
  resultKey: string,
  wrapped: ReadonlyArray<{ index: number; updates?: Record<string, unknown> }>,
  errors: ReadonlyArray<{ index: number; error?: string }>,
): VariantOutcome[] {
  const outcomes: VariantOutcome[] = new Array(arms.length);
  for (const entry of wrapped) {
    const outcome = entry.updates?.[resultKey];
    if (outcome !== undefined) outcomes[entry.index] = outcome as VariantOutcome;
  }
  for (const entry of errors) {
    outcomes[entry.index] = errorOutcome(
      arms[entry.index]!.variant,
      entry.error ?? 'worker failed without a message',
    );
  }
  for (let i = 0; i < arms.length; i++) {
    if (outcomes[i] === undefined) {
      outcomes[i] = errorOutcome(arms[i]!.variant, 'the fan-out returned no result for this arm');
    }
  }
  return outcomes;
}

/** The worker's result key inside each wrapper. */
export const MEASURE_WORKER_RESULT_KEY = 'fork_result';

/**
 * Build the measure graph over one workflow's recorded runs.
 *
 * Reads its batch from `memory.plan.arms` (seed it directly, or map a
 * parent's plan in through subgraph `inputs`), fans out, and ends at the
 * map node with wrappers under {@link MEASURE_RESULTS_KEY}.
 */
export function buildMeasureGraph(
  scenario: Scenario,
  params: unknown,
  stack: Stack,
  options: MeasureOptions = {},
) {
  const forkArm = tool({
    name: 'fork_arm',
    description: "Fork one base run with one variant's changes and report what the tail did.",
    parameters: z.object({
      map_item: z.unknown().optional(),
      map_index: z.number().optional(),
      map_total: z.number().optional(),
    }),
    // A fork runs a live workflow tail; the default per-call timeout is for
    // tools that answer, not tools that orchestrate.
    timeoutMs: 0,
    execute: async (args): Promise<VariantOutcome> => {
      const arm = args.map_item as MeasureArm;
      options.onProgress?.(arm.label ?? `${arm.variant} from ${arm.baseRunId.slice(0, 8)}`);
      try {
        const outcome = await forkRecordedRun(scenario, params, stack, arm.baseRunId, {
          at: arm.at,
          change: arm.changes,
        });
        return await outcomeOf(stack, arm, outcome.runId, outcome.evals);
      } catch (err) {
        return errorOutcome(arm.variant, err);
      }
    },
  });

  const worker = node({
    id: 'fork',
    type: 'tool',
    toolId: 'fork_arm',
    tools: [forkArm],
    reads: [],
  });

  const fan = mapReduce(worker, {
    id: 'measure',
    items: `$.memory.${MEASURE_PLAN_KEY}.arms`,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    reads: [MEASURE_PLAN_KEY],
  });

  return graph({
    name: 'measure-arms',
    description: 'Fan out over sweep arms, forking each against its base run.',
    nodes: [fan, worker],
    edges: [],
    startNode: fan,
    endNodes: [fan],
  });
}

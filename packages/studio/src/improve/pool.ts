/**
 * Draw pooling: reuse of recorded forks
 *
 * Every fork is recorded with the key that determines its distribution — the
 * base run, the fork point, the changes, the model — so the artifact tree is
 * a memo table for arms already measured. A sweep re-running an arm it ran
 * yesterday is not measuring anything new; it is redrawing from a
 * distribution the corpus already holds draws of.
 *
 * The one rule that separates this from ordinary memoization: a fork result
 * is a **draw, not a value**. Serving one recorded draw as five samples would
 * manufacture certainty out of a single observation, the same bug the
 * node-level memoizer had when repeated fingerprints froze fix-loops. So the
 * pool is consumed, never replayed: each reused draw is one recorded fork,
 * used once per pass, and an arm needing more draws than the pool holds runs
 * the difference fresh.
 *
 * Reuse assumes the draws are exchangeable with fresh ones: same prefix, same
 * effective changes, same model — and the same engine, which nothing records.
 * An engine change that alters sampling behaviour makes old draws a different
 * population, which is why reuse is opt-in rather than the default.
 *
 * @module improve/pool
 */

import { ChangeSchema, canonicalEquals } from '@cycgraph/orchestrator';
import type { Change } from '@cycgraph/orchestrator';
import { computeMs } from '@cycgraph/evals';
import type { VariantOutcome } from '@cycgraph/evals';
import { loadHistory } from '../run/history.js';
import { readEpoch } from './proposals.js';
import type { HistoryEntry } from '../run/history.js';
import { toTelemetry } from '../run/insights.js';

/** How many recorded runs are scanned for reusable draws. */
const POOL_LIMIT = 500;

/** What identifies the distribution an arm draws from. */
export interface DrawKey {
  baseRunId: string;
  /** Where the fork diverges, resolved to the recorded sequence id. */
  forkSequenceId: number;
  changes: readonly Change[];
  model: string;
}

/**
 * Changes in their schema-normalised form, so a recorded fork's stored
 * changes and a sweep's authored ones compare structurally rather than by
 * accident of construction. Unparseable input compares equal to nothing.
 */
function normalise(changes: unknown): Change[] | undefined {
  if (!Array.isArray(changes)) return undefined;
  try {
    return changes.map(entry => ChangeSchema.parse(entry));
  } catch {
    return undefined;
  }
}

/** Whether a recorded fork is a draw from the keyed distribution. */
function matches(entry: HistoryEntry, key: DrawKey, wanted: Change[]): boolean {
  if (entry.meta.parentRunId !== key.baseRunId) return false;
  if (entry.meta.forkSequenceId !== key.forkSequenceId) return false;
  if (entry.meta.stack?.model !== key.model) return false;
  // Only tails that actually ran. A memoized fork's timings measure the
  // recording, not the work, and a fork recorded before the flag existed is
  // excluded the same way rather than guessed about.
  if (entry.meta.forkMemoized !== false) return false;
  // A fork that checked no assertions established nothing worth reusing.
  if (entry.total === 0) return false;

  const recorded = normalise(entry.meta.forkChanges);
  return recorded !== undefined && canonicalEquals(recorded, wanted);
}

/**
 * Recorded draws from one arm's distribution, newest first.
 *
 * `consumed` is the pass's ledger of run ids already reused, shared across
 * arms so no recorded draw is counted twice — two arms with identical
 * effective changes are the same distribution, and double-counting one draw
 * between them would be the pseudo-replication this module exists to avoid.
 */
export async function findReusableDraws(
  artifactRoot: string,
  scenarioId: string,
  key: DrawKey,
  name: string,
  needed: number,
  consumed: Set<string>,
): Promise<VariantOutcome[]> {
  if (needed <= 0) return [];

  const wanted = normalise([...key.changes]);
  if (!wanted) return [];

  const entries = await loadHistory(artifactRoot, { scenarioId, limit: POOL_LIMIT });
  // Draws from before the last source write are samples of a workflow that no
  // longer exists, which is the exchangeability rule this module lives by.
  const epoch = await readEpoch(artifactRoot);
  const draws: VariantOutcome[] = [];

  for (const entry of entries) {
    if (epoch && entry.meta.startedAt < epoch) continue;
    if (draws.length >= needed) break;
    if (consumed.has(entry.meta.runId)) continue;
    if (!matches(entry, key, wanted)) continue;

    const telemetry = await toTelemetry(entry);
    const ms = computeMs(telemetry);
    if (ms === undefined) continue;

    consumed.add(entry.meta.runId);
    draws.push({
      name,
      runId: entry.meta.runId,
      assertionsHeld: entry.passed === entry.total,
      failed: entry.evals.filter(result => !result.passed).map(result => result.assertion.type),
      computeMs: ms,
      tokens: telemetry.totalTokens,
      reused: true,
    });
  }

  return draws;
}

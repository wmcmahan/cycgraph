/**
 * Gated Lesson Retriever
 *
 * Retrieval policy for eval-gated lessons: fill most of the prompt budget
 * with `verified` lessons, but reserve a few exploration slots for
 * `candidate` lessons so they accrue the trials the retention gate needs.
 *
 * With a `ledger`, candidate selection is in-progress-first: candidates that
 * already have trials keep their slots until the gate rules on them, so a
 * trial cohort graduates before the next starts and selection converges even
 * when reflection adds candidates every run. Without one it falls back to
 * newest-first, safe only for a small, stable candidate pool.
 *
 * Facts carrying neither status tag count as verified, so stores written
 * before eval-gating existed keep working unchanged.
 *
 * Ordering is fully deterministic (trial counts, `valid_from`, `id` tiebreak) —
 * no sampling — so retrieval is reproducible given the same store and ledger.
 *
 * @module retrieval/gated-lesson-retriever
 */

import { QUARANTINE_TAG, type MemoryStore } from '../interfaces/memory-store.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { OutcomeLedger } from '../consolidation/outcome-ledger.js';

export interface GatedLessonOptions {
  /** Scope tags (OR semantics), e.g. `['lesson', 'graph:research-v1']`. */
  tags: string[];
  /** Tag marking on-trial lessons (default `'candidate'`). */
  candidateTag?: string;
  /** Total lessons to return (default 10). */
  maxFacts?: number;
  /**
   * Slots reserved for candidates (default 2). Set to 0 to retrieve
   * verified lessons only — but note candidates then never accrue
   * trials and the retention gate holds them forever.
   */
  candidateSlots?: number;
  /**
   * Outcome ledger for in-progress-first candidate selection.
   * Strongly recommended whenever reflection keeps producing new
   * candidates — without it, newest-first selection churns the slots
   * and no candidate ever reaches `minTrials`.
   */
  ledger?: OutcomeLedger;
  /**
   * Bench candidates once they have this many trials (requires
   * `ledger`). Set it to the retention policy's `minTrials`.
   *
   * Without a rest phase, a candidate that fills every run can never be
   * judged: the leave-one-out baseline needs runs WITHOUT the fact.
   * Resting creates those absence runs and frees the slots for the next
   * cohort — trial → rest → verdict. Rested candidates stay in the pool
   * (still tagged candidate) until the gate promotes or evicts them.
   */
  restAfterTrials?: number;
}

/** Newest first, with id as a deterministic tiebreak. */
function byRecency(a: SemanticFact, b: SemanticFact): number {
  const delta = b.valid_from.getTime() - a.valid_from.getTime();
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

/**
 * Retrieve lessons under the gated policy: verified lessons fill
 * `maxFacts − candidateSlots`; candidates fill the rest —
 * in-progress-first when a ledger is provided, newest-first otherwise.
 * Unused candidate slots fall back to additional verified lessons.
 */
export async function retrieveGatedLessons(
  store: MemoryStore,
  options: GatedLessonOptions,
): Promise<SemanticFact[]> {
  const candidateTag = options.candidateTag ?? 'candidate';
  const maxFacts = options.maxFacts ?? 10;
  const candidateSlots = Math.min(options.candidateSlots ?? 2, maxFacts);

  // Scope tags use OR semantics in findFacts; status partitioning is
  // done client-side so one query serves both pools. Quarantined (poisoned)
  // facts are excluded so a lesson from a failed/tainted run can never be
  // retrieved as trusted guidance.
  const scoped = await store.findFacts({
    tags: options.tags,
    excludeTags: [QUARANTINE_TAG],
    includeInvalidated: false,
    limit: 1000,
  });

  const candidates: SemanticFact[] = [];
  const verified: SemanticFact[] = [];
  for (const fact of scoped) {
    if (fact.tags.includes(candidateTag)) {
      candidates.push(fact);
    } else {
      // Verified tag or no status tag at all — pre-gate lessons count
      // as verified for backward compatibility.
      verified.push(fact);
    }
  }

  verified.sort(byRecency);

  // Always a copy: the sorts below must not reorder the partition array.
  let eligible = [...candidates];
  if (options.ledger) {
    // In-progress-first ordering (most trials first, then oldest). Sorting
    // fewest-trials-first instead would let perpetual 0-trial newcomers
    // monopolise the slots and no cohort would ever graduate.
    const trials = new Map<string, number>();
    if (options.ledger.getFactStatsBatch) {
      const stats = await options.ledger.getFactStatsBatch(candidates.map((f) => f.id));
      for (const fact of candidates) {
        trials.set(fact.id, stats.get(fact.id)?.trials ?? 0);
      }
    } else {
      for (const fact of candidates) {
        const stats = await options.ledger.getFactStats(fact.id);
        trials.set(fact.id, stats?.trials ?? 0);
      }
    }
    // Rest phase: fully-trialled candidates step out, creating the
    // absence runs their leave-one-out baseline requires.
    if (options.restAfterTrials !== undefined) {
      eligible = eligible.filter(
        (f) => (trials.get(f.id) ?? 0) < options.restAfterTrials!,
      );
    }
    eligible.sort((a, b) => {
      const delta = (trials.get(b.id) ?? 0) - (trials.get(a.id) ?? 0);
      if (delta !== 0) return delta;
      const age = a.valid_from.getTime() - b.valid_from.getTime();
      return age !== 0 ? age : a.id.localeCompare(b.id);
    });
  } else {
    eligible.sort(byRecency);
  }

  const chosenCandidates = eligible.slice(0, candidateSlots);
  const chosenVerified = verified.slice(0, maxFacts - chosenCandidates.length);

  const chosen = [...chosenVerified, ...chosenCandidates];

  // Usage bookkeeping for decay scoring (no-op without touchFacts). Lesson
  // *retention* stays governed by the eval gate; this only protects lessons
  // from age-based consolidation pruning while they are actively injected.
  if (chosen.length > 0) {
    await store.touchFacts?.(chosen.map((f) => f.id));
  }

  return chosen;
}

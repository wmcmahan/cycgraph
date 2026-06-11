/**
 * Gated Lesson Retriever
 *
 * Retrieval policy for eval-gated lessons: fill most of the prompt
 * budget with `verified` lessons, but reserve a small number of
 * exploration slots for `candidate` lessons so they can accrue the
 * trials the retention gate needs. A candidate that is never retrieved
 * can never be promoted or evicted — `candidate_slots: 0` starves the
 * gate (documented foot-gun; default is 2).
 *
 * Candidate selection: pass the outcome `ledger` to get
 * **in-progress-first** ordering — candidates that already have trials
 * keep their slots until the gate can rule on them (a trial cohort),
 * and only then do fresh candidates enter. This converges even when
 * reflection adds new candidates every run. Without a ledger, selection
 * falls back to newest-first, which is only suitable when the candidate
 * pool is small and stable: a growing pool rotates candidates through
 * the slots faster than any of them can accrue trials, and the gate
 * holds them all forever.
 *
 * Pair in-progress-first with a `max_trials` retention policy: a
 * candidate the gate can never rule on (lift inside both margins)
 * otherwise keeps its slot indefinitely and starves the queue behind it.
 *
 * Facts carrying neither status tag are treated as verified, so lesson
 * stores written before eval-gating existed keep working unchanged.
 *
 * Ordering is fully deterministic (trial counts from the ledger,
 * `valid_from`, `id` tiebreak) — no sampling — so retrieval is
 * reproducible given the same store and ledger state.
 *
 * @module retrieval/gated-lesson-retriever
 */

import type { MemoryStore } from '../interfaces/memory-store.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { OutcomeLedger } from '../consolidation/outcome-ledger.js';

export interface GatedLessonOptions {
  /** Scope tags (OR semantics), e.g. `['lesson', 'graph:research-v1']`. */
  tags: string[];
  /** Tag marking on-trial lessons (default `'candidate'`). */
  candidate_tag?: string;
  /** Total lessons to return (default 10). */
  max_facts?: number;
  /**
   * Slots reserved for candidates (default 2). Set to 0 to retrieve
   * verified lessons only — but note candidates then never accrue
   * trials and the retention gate holds them forever.
   */
  candidate_slots?: number;
  /**
   * Outcome ledger for in-progress-first candidate selection.
   * Strongly recommended whenever reflection keeps producing new
   * candidates — without it, newest-first selection churns the slots
   * and no candidate ever reaches `min_trials`.
   */
  ledger?: OutcomeLedger;
  /**
   * Bench candidates once they have this many trials (requires
   * `ledger`). Set it to the retention policy's `min_trials`.
   *
   * Without a rest phase, a candidate that fills every run can never be
   * judged: the leave-one-out baseline needs runs WITHOUT the fact.
   * Resting creates those absence runs and frees the slots for the next
   * cohort — trial → rest → verdict. Rested candidates stay in the pool
   * (still tagged candidate) until the gate promotes or evicts them.
   */
  rest_after_trials?: number;
}

/** Newest first, with id as a deterministic tiebreak. */
function byRecency(a: SemanticFact, b: SemanticFact): number {
  const delta = b.valid_from.getTime() - a.valid_from.getTime();
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

/**
 * Retrieve lessons under the gated policy: verified lessons fill
 * `max_facts − candidate_slots`; candidates fill the rest —
 * in-progress-first when a ledger is provided, newest-first otherwise.
 * Unused candidate slots fall back to additional verified lessons.
 */
export async function retrieveGatedLessons(
  store: MemoryStore,
  options: GatedLessonOptions,
): Promise<SemanticFact[]> {
  const candidateTag = options.candidate_tag ?? 'candidate';
  const maxFacts = options.max_facts ?? 10;
  const candidateSlots = Math.min(options.candidate_slots ?? 2, maxFacts);

  // Scope tags use OR semantics in findFacts; status partitioning is
  // done client-side so one query serves both pools.
  const scoped = await store.findFacts({
    tags: options.tags,
    include_invalidated: false,
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

  let eligible = candidates;
  if (options.ledger) {
    // In-progress-first: candidates that already have trials keep their
    // slots until they finish their trial phase (most trials first),
    // then fresh candidates enter oldest-first. A trial cohort
    // graduates before the next one starts — this converges even when
    // new candidates arrive every run, which fewest-trials-first does
    // not (perpetual 0-trial newcomers would monopolise the slots).
    const trials = new Map<string, number>();
    for (const fact of candidates) {
      const stats = await options.ledger.getFactStats(fact.id);
      trials.set(fact.id, stats?.trials ?? 0);
    }
    // Rest phase: fully-trialled candidates step out, creating the
    // absence runs their leave-one-out baseline requires.
    if (options.rest_after_trials !== undefined) {
      eligible = candidates.filter(
        (f) => (trials.get(f.id) ?? 0) < options.rest_after_trials!,
      );
    }
    eligible.sort((a, b) => {
      const delta = (trials.get(b.id) ?? 0) - (trials.get(a.id) ?? 0);
      if (delta !== 0) return delta;
      const age = a.valid_from.getTime() - b.valid_from.getTime();
      return age !== 0 ? age : a.id.localeCompare(b.id);
    });
  } else {
    eligible = [...candidates].sort(byRecency);
  }

  const chosenCandidates = eligible.slice(0, candidateSlots);
  const chosenVerified = verified.slice(0, maxFacts - chosenCandidates.length);

  return [...chosenVerified, ...chosenCandidates];
}

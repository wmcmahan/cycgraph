/**
 * Was the fork better?
 *
 * A diff says what changed. It cannot say whether that was an improvement,
 * and reading "draft +180B" to decide whether a workflow got better is not
 * a judgment anyone should be asked to make from a byte count.
 *
 * Three signals answer it, in descending order of how much they are worth:
 *
 * 1. **The scenario's assertions.** They already encode what the run is
 *    supposed to achieve, they are objective, and they cost nothing to check
 *    against a fork's final state. This is the answer whenever it exists.
 * 2. **Terminal status.** Failed to completed is better; the reverse is worse.
 *    Unambiguous, and independent of what the run was for.
 * 3. **Cost.** Decides only when the outcome is otherwise provably identical.
 *    Cheaper output nobody wanted is not an improvement, but the same output
 *    for less money is exactly the answer to "can this run on a cheaper
 *    model".
 *
 * When none of them moved, the verdict is **unclear** and says so. A fork that
 * rewrote a draft has changed something no assertion measures, and reporting
 * "no change" would be false while reporting "better" would be invented. Saying
 * that quality moved and nothing here scores it is the honest answer, and it
 * points at what would: a scorer.
 *
 * @module improve/verdict
 */

import type { AssertionResult } from '@cycgraph/orchestrator';

/** Which way a fork went. */
export type VerdictKind = 'better' | 'worse' | 'mixed' | 'unchanged' | 'unclear';

/** One reason behind a verdict, already phrased for a reader. */
export interface VerdictReason {
  direction: 'better' | 'worse' | 'neutral';
  text: string;
}

/** Whether a fork improved on the run it forked, and why. */
export interface Verdict {
  kind: VerdictKind;
  /** One line, suitable as a headline. */
  summary: string;
  reasons: VerdictReason[];
}

/** Context for the message an unmeasurable change produces. */
export interface VerdictContext {
  /** Named in the advice, so it points at a file rather than a concept. */
  scenarioId?: string;
}

/** What the comparison needs from each side. */
export interface VerdictInput {
  status: string;
  evals: readonly AssertionResult[];
  costUsd: number;
  /** Memory keys that differ, so an unmeasured change can be named. */
  changedKeys?: readonly string[];
  /** A caller's own quality score, when one was computed. */
  score?: number;
}

const TERMINAL_GOOD = new Set(['completed']);

/** Compare a fork against the run it forked. */
export function judgeFork(
  base: VerdictInput,
  variant: VerdictInput,
  context: VerdictContext = {},
): Verdict {
  const reasons: VerdictReason[] = [];

  // 1. Assertions, when the scenario declares any.
  const basePassed = base.evals.filter((r) => r.passed).length;
  const variantPassed = variant.evals.filter((r) => r.passed).length;
  if (variant.evals.length > 0) {
    const delta = variantPassed - basePassed;
    if (delta !== 0) {
      reasons.push({
        direction: delta > 0 ? 'better' : 'worse',
        text: `${variantPassed}/${variant.evals.length} assertions pass, was ${basePassed}/${base.evals.length}`,
      });
    }
  }

  // 2. Terminal status.
  if (base.status !== variant.status) {
    const wasGood = TERMINAL_GOOD.has(base.status);
    const isGood = TERMINAL_GOOD.has(variant.status);
    reasons.push({
      direction: isGood && !wasGood ? 'better' : !isGood && wasGood ? 'worse' : 'neutral',
      text: `${variant.status}, was ${base.status}`,
    });
  }

  // 3. A caller's score, when one exists.
  if (base.score !== undefined && variant.score !== undefined) {
    const delta = variant.score - base.score;
    if (Math.abs(delta) > 1e-9) {
      reasons.push({
        direction: delta > 0 ? 'better' : 'worse',
        text: `score ${variant.score.toFixed(3)}, was ${base.score.toFixed(3)}`,
      });
    }
  }

  // 4. Cost. Recorded as neutral here and promoted to the verdict below only
  //    when nothing else moved and the output is identical.
  const costDelta = variant.costUsd - base.costUsd;
  if (Math.abs(costDelta) > 1e-6) {
    reasons.push({
      direction: 'neutral',
      text: costDelta < 0
        ? `$${Math.abs(costDelta).toFixed(4)} cheaper`
        : `$${costDelta.toFixed(4)} dearer`,
    });
  }

  const better = reasons.filter((r) => r.direction === 'better').length;
  const worse = reasons.filter((r) => r.direction === 'worse').length;

  if (better > 0 && worse > 0) {
    return { kind: 'mixed', summary: summarize('mixed', reasons), reasons };
  }
  if (better > 0) return { kind: 'better', summary: summarize('better', reasons), reasons };
  if (worse > 0) return { kind: 'worse', summary: summarize('worse', reasons), reasons };

  // Nothing measurable moved. Whether that means "identical" or "changed in a
  // way nothing here measures" depends on whether memory actually differs, and
  // the distinction is the whole point of the question.
  const changed = variant.changedKeys ?? [];
  const cost = reasons.find((r) => r.text.includes('cheaper') || r.text.includes('dearer'));

  if (changed.length === 0) {
    // Cost decides here and nowhere else. It is a weak signal against a
    // changed output — cheaper output nobody wanted is not an improvement —
    // but against a provably identical one it is the whole answer, and it is
    // the answer to "can this run on a cheaper model".
    if (cost) {
      const cheaper = cost.text.includes('cheaper');
      return {
        kind: cheaper ? 'better' : 'worse',
        summary: `${cheaper ? 'better' : 'worse'} — same result, ${cost.text}`,
        reasons,
      };
    }
    return {
      kind: 'unchanged',
      summary: 'unchanged — the fork produced the same result',
      reasons,
    };
  }

  // Name the field, not the idea. "Add an assertion" reads as advice about
  // evals in general, and this repo has two things by that name: a scenario's
  // `evals()` callback and the `@cycgraph/evals` package. Only the first one
  // answers this.
  const where = context.scenarioId
    ? `${context.scenarioId}'s evals() block`
    : "the scenario's evals() block";

  return {
    kind: 'unclear',
    summary: `unclear — ${changed.join(', ')} changed, and no assertion covers ${changed.length > 1 ? 'those keys' : 'that key'}. `
      + `Add one to ${where}: memory_matches to pin a shape, or llm_judge to score quality.`
      + (cost ? ` (${cost.text})` : ''),
    reasons,
  };
}

/** The headline, built from the reasons that carry a direction. */
function summarize(kind: VerdictKind, reasons: readonly VerdictReason[]): string {
  const directed = reasons.filter((r) => r.direction !== 'neutral').map((r) => r.text);
  const neutral = reasons.filter((r) => r.direction === 'neutral').map((r) => r.text);
  return [`${kind} — ${directed.join('; ')}`, ...neutral].join(' · ');
}

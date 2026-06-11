/**
 * Retention Gate
 *
 * The eval-gating decision: given accumulated run-outcome evidence (an
 * `OutcomeLedger`), promote candidate lessons that demonstrably lift
 * outcomes and evict the ones that hurt or never help.
 *
 * Lesson lifecycle is tag-driven:
 *
 *   candidate ──(mean − baseline ≥ promote_margin)──▶ verified
 *      │
 *      ├──(baseline − mean ≥ evict_margin)──▶ invalidated 'eval-gate:harmful'
 *      └──(max_trials reached, no lift)─────▶ invalidated 'eval-gate:no_lift'
 *
 * Uses the same collect-then-apply mutation pattern and soft-delete
 * convention (`invalidated_by`) as `MemoryConsolidator`, so evicted
 * facts remain recoverable via `findFacts({ include_invalidated: true })`.
 *
 * Re-running the gate is idempotent: promoted facts no longer carry the
 * candidate tag, and evicted facts are excluded from the default
 * `findFacts` listing.
 *
 * @module consolidation/retention-gate
 */

import { z } from 'zod';
import type { MemoryStore } from '../interfaces/memory-store.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { OutcomeLedger } from './outcome-ledger.js';

export const RetentionPolicySchema = z.object({
  /** Minimum runs a candidate must appear in before any decision. */
  min_trials: z.number().int().min(1).default(3),
  /** Required lift over the leave-one-out baseline to promote. */
  promote_margin: z.number().min(0).default(0.05),
  /** Required drop below the leave-one-out baseline to evict as harmful. */
  evict_margin: z.number().min(0).default(0.05),
  /** Tag marking unproven lessons. */
  candidate_tag: z.string().default('candidate'),
  /** Tag marking lessons that earned their place. */
  verified_tag: z.string().default('verified'),
  /**
   * Trials after which a candidate showing no promotable lift is evicted
   * as useless. Omit to keep no-lift candidates on trial indefinitely.
   */
  max_trials: z.number().int().min(1).optional(),
});

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export type EvictionReason = 'eval-gate:harmful' | 'eval-gate:no_lift';

export interface RetentionReport {
  /** Fact IDs promoted candidate → verified this pass. */
  promoted: string[];
  /** Facts invalidated this pass, with the gate's reason. */
  evicted: Array<{ fact_id: string; reason: EvictionReason }>;
  /** Candidates left on trial (insufficient evidence either way). */
  held: Array<{ fact_id: string; trials: number }>;
}

/**
 * Evaluate every active candidate lesson against the ledger evidence and
 * apply promotions/evictions to the store.
 *
 * @param store - The memory store holding lesson facts.
 * @param ledger - Accumulated run outcomes (see `OutcomeLedger`).
 * @param policy - Thresholds; unspecified fields use schema defaults.
 */
export async function evaluateRetention(
  store: MemoryStore,
  ledger: OutcomeLedger,
  policy: Partial<RetentionPolicy> = {},
): Promise<RetentionReport> {
  const cfg = RetentionPolicySchema.parse(policy);
  const report: RetentionReport = { promoted: [], evicted: [], held: [] };

  // Load active candidates in batches (mirrors MemoryConsolidator).
  const batchSize = 1000;
  const candidates: SemanticFact[] = [];
  let offset = 0;
  while (true) {
    const batch = await store.findFacts({
      tags: [cfg.candidate_tag],
      include_invalidated: false,
      limit: batchSize,
      offset,
    });
    candidates.push(...batch);
    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  // Collect mutations first; apply at the end so a mid-pass failure
  // never leaves a half-gated store.
  const mutations: SemanticFact[] = [];

  for (const fact of candidates) {
    const stats = await ledger.getFactStats(fact.id);
    const trials = stats?.trials ?? 0;

    if (stats === null || trials < cfg.min_trials) {
      report.held.push({ fact_id: fact.id, trials });
      continue;
    }

    const baseline = await ledger.getBaseline(fact.id);
    // No comparison runs exist (every recorded run contained this fact):
    // there is nothing to judge lift against, so hold — but still honour
    // max_trials. Without this, a fact present in every run deadlocks:
    // it is held forever AND (under in-progress-first retrieval) keeps
    // its exploration slot, starving the queue behind it.
    if (baseline.runs === 0) {
      if (cfg.max_trials !== undefined && trials >= cfg.max_trials) {
        mutations.push({ ...fact, invalidated_by: 'eval-gate:no_lift' });
        report.evicted.push({ fact_id: fact.id, reason: 'eval-gate:no_lift' });
      } else {
        report.held.push({ fact_id: fact.id, trials });
      }
      continue;
    }

    const lift = stats.mean_score - baseline.mean_score;

    if (lift >= cfg.promote_margin) {
      mutations.push({
        ...fact,
        tags: [...fact.tags.filter((t) => t !== cfg.candidate_tag), cfg.verified_tag],
      });
      report.promoted.push(fact.id);
    } else if (-lift >= cfg.evict_margin) {
      mutations.push({ ...fact, invalidated_by: 'eval-gate:harmful' });
      report.evicted.push({ fact_id: fact.id, reason: 'eval-gate:harmful' });
    } else if (cfg.max_trials !== undefined && trials >= cfg.max_trials) {
      mutations.push({ ...fact, invalidated_by: 'eval-gate:no_lift' });
      report.evicted.push({ fact_id: fact.id, reason: 'eval-gate:no_lift' });
    } else {
      report.held.push({ fact_id: fact.id, trials });
    }
  }

  for (const fact of mutations) {
    await store.putFact(fact);
  }

  return report;
}

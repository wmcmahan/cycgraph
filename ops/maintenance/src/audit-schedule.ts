/**
 * Audit patrol scheduler: which charters a budget-capped run spends its
 * slots on.
 *
 * A scheduler, not a filter. Nothing is ever memoized away — an audit is
 * a sample, not a proof, so an unchanged tree is never treated as
 * verified. The ordering shapes FREQUENCY instead: scopes changed since
 * the last audited commit take slots first (for changed code the
 * docs-diff causality genuinely holds), and the remaining slots fill
 * from the full lens × scope cross-product oldest-audited-first, so
 * stable code keeps getting fresh eyes — with the current lesson pool
 * and model — on a bounded cycle, and fix-churn cannot monopolise the
 * budget.
 *
 * State is one fixed-id fact in the lesson store (both stores upsert on
 * id): the last audited commit and a per-pair last-audited timestamp.
 *
 * @module maintenance/audit-schedule
 */

import type { MemoryStore, SemanticFact } from '@cycgraph/memory';

/** Fixed id of the single schedule-state fact (upserted, never appended). */
export const AUDIT_SCHEDULE_FACT_ID = '00000000-a0d1-4000-8000-5c4ed01e0000';

/** Tag the schedule fact carries so no lesson query ever retrieves it. */
export const AUDIT_SCHEDULE_TAG = 'audit-schedule';

/** Persistent scheduler state. */
export interface AuditSchedule {
  /** Commit the most recent audit ran against. */
  head?: string;
  /** `lens|scope` -> ISO timestamp of the last run that audited the pair. */
  pairs: Record<string, string>;
}

/** The stable key for one (lens, scope) charter. */
export function pairKey(lens: string, scope: string): string {
  return `${lens}|${scope}`;
}

/**
 * Order the charter cross-product for a budget-capped run: pairs whose
 * scope changed since the last audited commit first (keeping their
 * diagonal order among themselves), then the rest oldest-audited-first
 * with never-audited pairs ahead of everything dated. Ties keep the
 * incoming diagonal order, so with no state at all this degrades to
 * exactly the previous behavior.
 */
export function scheduleCharters(
  pairs: Array<{ lens: string; scope: string }>,
  options: { changedScopes?: ReadonlySet<string>; schedule?: AuditSchedule },
): Array<{ lens: string; scope: string }> {
  const changed = options.changedScopes ?? new Set<string>();
  const audited = options.schedule?.pairs ?? {};

  return pairs
    .map((pair, index) => ({
      pair,
      index,
      isChanged: changed.has(pair.scope),
      auditedAt: audited[pairKey(pair.lens, pair.scope)],
    }))
    .sort((a, b) => {
      if (a.isChanged !== b.isChanged) return a.isChanged ? -1 : 1;
      if (!a.isChanged) {
        const aTime = a.auditedAt === undefined ? -Infinity : Date.parse(a.auditedAt);
        const bTime = b.auditedAt === undefined ? -Infinity : Date.parse(b.auditedAt);
        if (aTime !== bTime) return aTime - bTime;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.pair);
}

/** Load the schedule state, or `undefined` when none has been recorded. */
export async function loadAuditSchedule(store: MemoryStore): Promise<AuditSchedule | undefined> {
  const fact = await store.getFact(AUDIT_SCHEDULE_FACT_ID);
  if (!fact) return undefined;
  try {
    const parsed = JSON.parse(fact.content) as AuditSchedule;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.pairs === 'object'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the pairs one run audited, merged over the existing state so a
 * budget-capped run only advances the pairs it actually spent slots on.
 */
export async function saveAuditSchedule(
  store: MemoryStore,
  update: { head: string; auditedPairs: Array<{ lens: string; scope: string }>; at: Date },
): Promise<void> {
  const existing = await loadAuditSchedule(store);
  const pairs = { ...(existing?.pairs ?? {}) };
  for (const { lens, scope } of update.auditedPairs) {
    pairs[pairKey(lens, scope)] = update.at.toISOString();
  }

  const fact: SemanticFact = {
    id: AUDIT_SCHEDULE_FACT_ID,
    content: JSON.stringify({ head: update.head, pairs } satisfies AuditSchedule),
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'derived', created_at: update.at, node_id: 'audit-schedule' },
    valid_from: update.at,
    tags: [AUDIT_SCHEDULE_TAG],
  };
  await store.putFact(fact);
}

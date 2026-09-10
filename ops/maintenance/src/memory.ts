/**
 * Cross-run lesson memory for the maintenance workflows.
 *
 * Wires the engine's memory seams to the same Postgres the runs record
 * into: reflection nodes write candidate lessons through a
 * paraphrase-aware admission gate, working agents retrieve them
 * eval-gated (verified first, a couple of exploration slots), and each
 * run's gate verdict becomes outcome evidence so `evaluateRetention`
 * can promote lessons that correlate with passing gates and evict ones
 * that do not.
 *
 * Same contract as run recording: `DATABASE_URL` set means durable,
 * absent means the whole subsystem is off and every workflow builds the
 * exact graph it built before.
 *
 * @module maintenance/memory
 */

import { randomUUID } from 'node:crypto';
import type { MemoryRetriever, MemoryWriter } from '@cycgraph/orchestrator';
import type { RetentionReport } from '@cycgraph/memory';
import { loadAuditSchedule, saveAuditSchedule, type AuditSchedule } from './audit-schedule.js';

/** Tag every maintenance lesson carries; workflows add `wf:<id>` beside it. */
export const LESSON_TAG = 'lesson';

/** Status tag a freshly written lesson carries until the gate promotes it. */
export const CANDIDATE_TAG = 'candidate';

/** The wired lesson-memory subsystem for one maintenance run. */
export interface MaintenanceMemory {
  memoryRetriever: MemoryRetriever;
  memoryWriter: MemoryWriter;
  /** Record one run's outcome against the lessons injected into it. */
  recordOutcome(runId: string, score: number, factIds: string[]): Promise<void>;
  /** Run the promote/evict gate over all candidate lessons. */
  retention(): Promise<RetentionReport>;
  /** Read the audit patrol's scheduler state. */
  loadAuditSchedule(): Promise<AuditSchedule | undefined>;
  /** Record the pairs one audit run spent slots on. */
  saveAuditSchedule(update: { head: string; auditedPairs: Array<{ lens: string; scope: string }>; at: Date }): Promise<void>;
}

/**
 * Wire lesson memory when `DATABASE_URL` is set; `undefined` otherwise.
 *
 * The store and ledger share the process pool the durability layer opens,
 * so the caller closes nothing here — `closeDb()` at the end of the run
 * covers both. Imported dynamically for the same reason as durability:
 * the runner must work without a database driver loaded.
 */
export async function memoryFromEnv(): Promise<MaintenanceMemory | undefined> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') return undefined;

  const { DrizzleMemoryStore, DrizzleOutcomeLedger, SEED_TENANT_ID } = await import('@cycgraph/orchestrator-postgres');
  const { checkFactAdmission, retrieveGatedLessons, evaluateRetention } = await import('@cycgraph/memory');
  // Tenant-scoped so every statement runs inside withTenant with the RLS
  // GUC set: the runtime role is subject to row security. Unscoped, the
  // policies degrade by environment — an unset GUC reads as NULL on a
  // direct connection (zero rows, the fail-safe 0018 documents) but as ''
  // through a pooler that resets GUCs, which errors on the ::uuid cast.
  // Neither is correct operation; the scope is what makes either sound.
  const store = new DrizzleMemoryStore({ tenant: { tenant_id: SEED_TENANT_ID } });
  const ledger = new DrizzleOutcomeLedger({ tenant: { tenant_id: SEED_TENANT_ID } });

  const memoryWriter: MemoryWriter = async (facts) => {
    const now = new Date();
    const ids: string[] = [];
    for (const fact of facts) {
      // Admission is scoped to the fact's own tags, so dedupe compares a
      // lesson against its workflow's pool rather than every workflow's.
      // The gate is paraphrase-aware and refuses re-entry of anything the
      // retention gate evicted, so reworded repeats cannot re-enter.
      const verdict = await checkFactAdmission(store, { content: fact.content }, { tags: fact.tags });
      if (!verdict.admit) continue;

      const id = randomUUID();
      await store.putFact({
        id,
        content: fact.content,
        source_episode_ids: [],
        entity_ids: [],
        provenance: {
          source: fact.provenance.source,
          created_at: now,
          run_id: fact.provenance.run_id,
          node_id: fact.provenance.node_id,
        },
        valid_from: now,
        tags: fact.tags,
      });
      ids.push(id);
    }
    return { fact_ids: ids };
  };

  const memoryRetriever: MemoryRetriever = async (query, options) => {
    const lessons = await retrieveGatedLessons(store, {
      tags: query.tags ?? [LESSON_TAG],
      maxFacts: options?.maxFacts ?? 10,
      candidateTag: CANDIDATE_TAG,
      ledger,
    });
    return {
      // `id` passthrough is load-bearing: it feeds `state.lesson_provenance`
      // so this run's gate verdict can be attributed to injected lessons.
      facts: lessons.map((f) => ({ content: f.content, validFrom: f.valid_from, id: f.id })),
      entities: [],
      themes: [],
    };
  };

  return {
    memoryRetriever,
    memoryWriter,
    recordOutcome: async (runId, score, factIds) => {
      await ledger.recordOutcome({ run_id: runId, score, fact_ids: factIds });
    },
    retention: () => evaluateRetention(store, ledger, { candidateTag: CANDIDATE_TAG }),
    loadAuditSchedule: () => loadAuditSchedule(store),
    saveAuditSchedule: (update) => saveAuditSchedule(store, update),
  };
}

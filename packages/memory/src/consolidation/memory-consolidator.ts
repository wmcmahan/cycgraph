/**
 * Memory Consolidator
 *
 * Prunes and deduplicates memory records to keep the store within
 * budget. Supports near-duplicate fact merging (via embedding
 * similarity), time-decay scoring, and episode pruning.
 *
 * Uses a collect-then-apply pattern: each phase computes its
 * mutations without writing, then all writes are applied at the end.
 * This prevents partial state if a write fails mid-consolidation.
 *
 * @module consolidation/memory-consolidator
 */

import { QUARANTINE_TAG, type MemoryStore } from '../interfaces/memory-store.js';
import type { MemoryIndex } from '../interfaces/memory-index.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';
import type { Episode } from '../schemas/episode.js';

/** Optional logger for consolidation diagnostic output. */
export interface ConsolidationLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

export interface ConsolidationOptions {
  /** Max facts to retain. Oldest/lowest-scoring pruned first. */
  maxFacts?: number;
  /** Max episodes to retain. */
  maxEpisodes?: number;
  /** Decay half-life in days (default 30). */
  decayHalfLifeDays?: number;
  /** Cosine similarity threshold for deduplicating facts (default 0.9). */
  dedupThreshold?: number;
  /** Whether to hard-delete or soft-delete (invalidate). Default: 'soft'. */
  deleteMode?: 'soft' | 'hard';
  /** Enable debug logging and mutation log in the report (default false). */
  debug?: boolean;
  /** Optional logger for warnings and debug output. */
  logger?: ConsolidationLogger;
  /** Batch size for paginated fact loading (default 1000). */
  batchSize?: number;
  /**
   * Tag marking a gate-promoted (trusted) lesson. When deduplicating
   * near-duplicates, a fact carrying this tag is never evicted in favor of one
   * that lacks it — otherwise an unproven (or poisoned) near-duplicate written
   * with a newer timestamp could invalidate a verified lesson. Default:
   * `'verified'` (matches the retention gate's `verifiedTag`).
   */
  verifiedTag?: string;
  /**
   * Tag marking an un-promoted candidate lesson. Dropped from the survivor when
   * it is merged into a verified keeper, so the kept fact doesn't end up tagged
   * both verified and candidate. Default: `'candidate'`.
   */
  candidateTag?: string;
}

export interface ConsolidationReport {
  /** Number of near-duplicate facts merged. */
  factsDeduped: number;
  /** Number of facts pruned due to low decay score. */
  factsDecayed: number;
  /** Number of episodes pruned. */
  episodesPruned: number;
  /** Number of themes whose fact_ids were updated. */
  themesCleanedUp: number;
  /** Number of themes deleted because all facts were pruned. */
  themesRemoved: number;
  /** Total records removed or invalidated. */
  totalReclaimed: number;
  /** Mutation log, populated when debug mode is enabled. */
  mutationLog?: Array<{ type: string; id: string }>;
}

export interface AutoConsolidationThresholds {
  /** Trigger consolidation when active fact count exceeds this. */
  maxFacts?: number;
  /** Trigger consolidation when episode count exceeds this. */
  maxEpisodes?: number;
}

// --- Mutation types (internal) ---

type Mutation =
  | { type: 'putFact'; fact: SemanticFact }
  | { type: 'deleteFact'; id: string }
  | { type: 'deleteEpisode'; id: string }
  | { type: 'putTheme'; theme: Theme }
  | { type: 'deleteTheme'; id: string };

export class MemoryConsolidator {
  constructor(
    private readonly store: MemoryStore,
    private readonly index: MemoryIndex,
    private readonly options: ConsolidationOptions = {},
  ) {}

  /**
   * Check whether the store has grown past the given thresholds.
   * Uses `limit: threshold + 1` to avoid loading the entire store.
   */
  static async shouldConsolidate(
    store: MemoryStore,
    thresholds: AutoConsolidationThresholds,
  ): Promise<boolean> {
    if (thresholds.maxFacts !== undefined) {
      const facts = await store.findFacts({ includeInvalidated: false, limit: thresholds.maxFacts + 1 });
      if (facts.length > thresholds.maxFacts) return true;
    }
    if (thresholds.maxEpisodes !== undefined) {
      const episodes = await store.listEpisodes({ limit: thresholds.maxEpisodes + 1 });
      if (episodes.length > thresholds.maxEpisodes) return true;
    }
    return false;
  }

  /**
   * Run consolidation only if the store exceeds the given thresholds.
   * Returns `null` if consolidation was not needed.
   */
  async autoConsolidate(
    thresholds: AutoConsolidationThresholds,
  ): Promise<ConsolidationReport | null> {
    const needed = await MemoryConsolidator.shouldConsolidate(this.store, thresholds);
    if (!needed) return null;
    return this.consolidate();
  }

  async consolidate(): Promise<ConsolidationReport> {
    const report: ConsolidationReport = {
      factsDeduped: 0,
      factsDecayed: 0,
      episodesPruned: 0,
      themesCleanedUp: 0,
      themesRemoved: 0,
      totalReclaimed: 0,
    };

    const mutations: Mutation[] = [];
    const prunedFactIds = new Set<string>();

    // 1. Deduplication (collect mutations)
    await this.planDedup(report, prunedFactIds, mutations);

    // 2. Decay scoring & pruning (collect mutations, aware of dedup decisions)
    await this.planDecay(report, prunedFactIds, mutations);

    // 3. Episode pruning (collect mutations)
    await this.planEpisodePrune(report, mutations);

    // 4. Theme cascade cleanup (collect mutations)
    await this.planCascadeThemes(prunedFactIds, report, mutations);

    // --- Apply all mutations ---
    const mutationLog = await this.applyMutations(mutations);

    if (this.options.debug) {
      report.mutationLog = mutationLog;
    }

    return report;
  }

  private async planDedup(
    report: ConsolidationReport,
    prunedFactIds: Set<string>,
    mutations: Mutation[],
  ): Promise<void> {
    const dedupThreshold = this.options.dedupThreshold ?? 0.9;
    const deleteMode = this.options.deleteMode ?? 'soft';
    const batchSize = this.options.batchSize ?? 1000;

    // Load facts in batches to avoid OOM on large stores
    const facts: SemanticFact[] = [];
    let offset = 0;
    while (true) {
      const batch = await this.store.findFacts({ includeInvalidated: false, excludeTags: [QUARANTINE_TAG], limit: batchSize, offset });
      facts.push(...batch);
      if (batch.length < batchSize) break;
      offset += batchSize;
    }

    const processed = new Set<string>();
    // Accumulate merged keepers so a fact that absorbs several duplicates keeps
    // ALL their evidence (emitting one putFact per candidate would let the last
    // merge overwrite earlier ones). Losers are recorded separately and emitted
    // once at the end.
    const keepers = new Map<string, SemanticFact>();
    const losers = new Map<string, { fact: SemanticFact; keeperId: string }>();

    for (const fact of facts) {
      if (!fact.embedding || processed.has(fact.id)) continue;

      const similar = await this.index.searchFacts(fact.embedding, {
        minSimilarity: dedupThreshold,
        limit: 100,
      });

      for (const { item: candidate } of similar) {
        if (candidate.id === fact.id) continue;
        if (processed.has(candidate.id)) continue;
        if (candidate.invalidated_by) continue;
        // The index holds all facts (incl. quarantined); never let a poisoned
        // near-duplicate participate in a merge (it isn't in `facts` either).
        if ((candidate.tags ?? []).includes(QUARANTINE_TAG)) continue;

        // Compare against the fact's ACCUMULATED state if it already absorbed
        // duplicates this pass, so keeper selection sees the merged evidence.
        const factState = keepers.get(fact.id) ?? fact;
        const keepFact = this.pickKeeper(factState, candidate);
        const loseFact = keepFact.id === factState.id ? candidate : factState;

        // Fold the loser's evidence into the keeper so a merge never loses
        // retrieval signal: union source episodes and tags, sum access counts.
        // Without this, deduping a verified lesson against a near-duplicate
        // silently dropped its access history and provenance.
        const merged = this.mergeIntoKeeper(keepFact, loseFact);
        keepers.set(merged.id, merged);
        keepers.delete(loseFact.id); // if the loser had been a keeper, retract it
        losers.set(loseFact.id, { fact: loseFact, keeperId: keepFact.id });

        processed.add(loseFact.id);
        prunedFactIds.add(loseFact.id);
        report.factsDeduped++;
        report.totalReclaimed++;

        // If `fact` itself just lost, stop comparing it against more candidates.
        if (loseFact.id === fact.id) break;
      }

      processed.add(fact.id);
    }

    // Emit accumulated merges, then the loser invalidations/deletes.
    for (const keeper of keepers.values()) {
      mutations.push({ type: 'putFact', fact: keeper });
    }
    for (const { fact: loser, keeperId } of losers.values()) {
      if (deleteMode === 'soft') {
        mutations.push({ type: 'putFact', fact: { ...loser, invalidated_by: keeperId } });
      } else {
        mutations.push({ type: 'deleteFact', id: loser.id });
      }
    }
  }

  /**
   * Choose which of two near-duplicate facts to keep. Priority, highest first:
   *   1. A verified (gate-promoted) fact beats an unverified one — a fresh or
   *      poisoned duplicate must never evict a proven lesson.
   *   2. Higher access_count (more-used ⇒ more load-bearing).
   *   3. More source episodes (more corroborating evidence).
   *   4. Newer `valid_from` (tie-breaker only).
   */
  private pickKeeper(a: SemanticFact, b: SemanticFact): SemanticFact {
    const verifiedTag = this.options.verifiedTag ?? 'verified';
    const aVerified = (a.tags ?? []).includes(verifiedTag);
    const bVerified = (b.tags ?? []).includes(verifiedTag);
    if (aVerified !== bVerified) return aVerified ? a : b;

    const aAccess = a.access_count ?? 0;
    const bAccess = b.access_count ?? 0;
    if (aAccess !== bAccess) return aAccess > bAccess ? a : b;

    if (a.source_episode_ids.length !== b.source_episode_ids.length) {
      return a.source_episode_ids.length > b.source_episode_ids.length ? a : b;
    }
    return a.valid_from >= b.valid_from ? a : b;
  }

  /** Union the loser's evidence (entities, episodes, tags, access count) into the keeper. */
  private mergeIntoKeeper(keeper: SemanticFact, loser: SemanticFact): SemanticFact {
    const verifiedTag = this.options.verifiedTag ?? 'verified';
    const candidateTag = this.options.candidateTag ?? 'candidate';

    // Union entity links: if the near-duplicates referenced different entities,
    // dropping the loser's would silently unlink the survivor from those
    // entities — entity-scoped retrieval and conflict detection (both group by
    // entity_id) would stop seeing this fact for them.
    const entity_ids = [...new Set([...keeper.entity_ids, ...loser.entity_ids])];
    const source_episode_ids = [...new Set([...keeper.source_episode_ids, ...loser.source_episode_ids])];
    let tags = [...new Set([...(keeper.tags ?? []), ...(loser.tags ?? [])])];
    // A verified survivor must not also carry the candidate tag — that would
    // send it back through the gate as if unproven.
    if (tags.includes(verifiedTag)) tags = tags.filter((t) => t !== candidateTag);
    const access_count = (keeper.access_count ?? 0) + (loser.access_count ?? 0);

    return { ...keeper, entity_ids, source_episode_ids, tags, access_count };
  }

  private async planDecay(
    report: ConsolidationReport,
    prunedFactIds: Set<string>,
    mutations: Mutation[],
  ): Promise<void> {
    const { maxFacts, decayHalfLifeDays = 30, deleteMode = 'soft' } = this.options;
    if (maxFacts === undefined) return;
    const batchSize = this.options.batchSize ?? 1000;

    // Load facts in batches to avoid OOM on large stores
    const allFacts: SemanticFact[] = [];
    let offset = 0;
    while (true) {
      const batch = await this.store.findFacts({ includeInvalidated: false, excludeTags: [QUARANTINE_TAG], limit: batchSize, offset });
      allFacts.push(...batch);
      if (batch.length < batchSize) break;
      offset += batchSize;
    }
    // Exclude facts already marked for pruning by dedup
    const facts = allFacts.filter((f) => !prunedFactIds.has(f.id));
    if (facts.length <= maxFacts) return;

    const now = Date.now();
    const halfLife = decayHalfLifeDays;

    const scored = facts.map((fact) => {
      // Age from last USE when tracked (`touchFacts`), else from creation: a
      // fact retrieved yesterday must not decay as if untouched since its
      // valid_from. Math.max guards odd data where last_accessed_at predates
      // valid_from.
      const lastUsedMs = fact.last_accessed_at
        ? Math.max(fact.last_accessed_at.getTime(), fact.valid_from.getTime())
        : fact.valid_from.getTime();
      const ageDays = (now - lastUsedMs) / (1000 * 60 * 60 * 24);
      // Floor the usage multiplier at 1: the schema defaults access_count to
      // 0, and a raw 0 would zero the score — schema-parsed facts would be
      // pruned first regardless of age while hand-built ones (undefined →
      // baseline 1) decay normally. Never-accessed means baseline, not doomed.
      const usage = Math.max(fact.access_count ?? 1, 1);
      const decayScore = usage * Math.pow(2, -ageDays / halfLife);
      return { fact, decayScore };
    });

    scored.sort((a, b) => a.decayScore - b.decayScore);

    const toPrune = scored.length - maxFacts;
    for (let i = 0; i < toPrune; i++) {
      const { fact } = scored[i];
      if (deleteMode === 'soft') {
        mutations.push({ type: 'putFact', fact: { ...fact, invalidated_by: 'consolidation:decay' } });
      } else {
        mutations.push({ type: 'deleteFact', id: fact.id });
      }
      prunedFactIds.add(fact.id);
      report.factsDecayed++;
      report.totalReclaimed++;
    }
  }

  private async planCascadeThemes(
    prunedFactIds: Set<string>,
    report: ConsolidationReport,
    mutations: Mutation[],
  ): Promise<void> {
    if (prunedFactIds.size === 0) return;

    const themes = await this.store.listThemes();

    for (const theme of themes) {
      const filtered = theme.fact_ids.filter((id) => !prunedFactIds.has(id));

      if (filtered.length === theme.fact_ids.length) continue;

      if (filtered.length === 0) {
        mutations.push({ type: 'deleteTheme', id: theme.id });
        report.themesRemoved++;
        report.totalReclaimed++;
      } else {
        const embedding = await this.computeCentroid(filtered);
        mutations.push({
          type: 'putTheme',
          theme: { ...theme, fact_ids: filtered, embedding },
        });
        report.themesCleanedUp++;
      }
    }
  }

  private async computeCentroid(factIds: string[]): Promise<number[] | undefined> {
    const factsMap = await this.store.getFacts(factIds);
    const embeddings: number[][] = [];

    for (const fact of factsMap.values()) {
      if (fact.embedding) {
        embeddings.push(fact.embedding);
      }
    }

    if (embeddings.length === 0) return undefined;

    const dims = embeddings[0].length;
    // Filter to embeddings with matching dimensionality to avoid silent corruption
    const valid = embeddings.filter(e => e.length === dims);
    if (valid.length === 0) return undefined;

    const centroid = new Array<number>(dims).fill(0);

    for (const emb of valid) {
      for (let i = 0; i < dims; i++) {
        centroid[i] += emb[i];
      }
    }

    for (let i = 0; i < dims; i++) {
      centroid[i] /= valid.length;
    }

    return centroid;
  }

  private async planEpisodePrune(
    report: ConsolidationReport,
    mutations: Mutation[],
  ): Promise<void> {
    const { maxEpisodes } = this.options;
    if (maxEpisodes === undefined) return;
    const batchSize = this.options.batchSize ?? 1000;

    // Batch-load ALL episodes (same pattern as the fact phases). A single
    // capped fetch of the newest N would leave episodes beyond the cap —
    // exactly the oldest ones this phase should prune — invisible forever.
    const episodes: Episode[] = [];
    let offset = 0;
    while (true) {
      const batch = await this.store.listEpisodes({ limit: batchSize, offset });
      episodes.push(...batch);
      if (batch.length < batchSize) break;
      offset += batchSize;
    }
    if (episodes.length <= maxEpisodes) return;

    // listEpisodes returns newest first; reverse so oldest is first
    episodes.reverse();

    const toPrune = episodes.length - maxEpisodes;
    for (let i = 0; i < toPrune; i++) {
      mutations.push({ type: 'deleteEpisode', id: episodes[i].id });
      report.episodesPruned++;
      report.totalReclaimed++;
    }
  }

  private async applyMutations(mutations: Mutation[]): Promise<Array<{ type: string; id: string }>> {
    const log: Array<{ type: string; id: string }> = [];

    // Pre-application validation: detect fact IDs that appear in both put and delete mutations.
    const putFactIds = new Set<string>();
    const deleteFactIds = new Set<string>();
    for (const m of mutations) {
      if (m.type === 'putFact') putFactIds.add(m.fact.id);
      if (m.type === 'deleteFact') deleteFactIds.add(m.id);
    }
    const conflictingIds = new Set<string>();
    for (const id of putFactIds) {
      if (deleteFactIds.has(id)) {
        (this.options.logger?.warn ?? console.warn)(`consolidation: conflicting mutations for fact ${id}, skipping`);
        conflictingIds.add(id);
      }
    }

    for (const mutation of mutations) {
      // Skip conflicting fact mutations
      if (mutation.type === 'putFact' && conflictingIds.has(mutation.fact.id)) continue;
      if (mutation.type === 'deleteFact' && conflictingIds.has(mutation.id)) continue;

      switch (mutation.type) {
        case 'putFact':
          await this.store.putFact(mutation.fact);
          log.push({ type: 'putFact', id: mutation.fact.id });
          break;
        case 'deleteFact':
          await this.store.deleteFact(mutation.id);
          log.push({ type: 'deleteFact', id: mutation.id });
          break;
        case 'deleteEpisode':
          await this.store.deleteEpisode(mutation.id);
          log.push({ type: 'deleteEpisode', id: mutation.id });
          break;
        case 'putTheme':
          await this.store.putTheme(mutation.theme);
          log.push({ type: 'putTheme', id: mutation.theme.id });
          break;
        case 'deleteTheme':
          await this.store.deleteTheme(mutation.id);
          log.push({ type: 'deleteTheme', id: mutation.id });
          break;
      }
    }

    return log;
  }
}

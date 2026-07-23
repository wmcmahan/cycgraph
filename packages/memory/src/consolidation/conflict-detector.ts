/**
 * Conflict Detector
 *
 * Identifies contradictory, negating, or superseding facts in
 * the memory store. Supports automatic resolution of temporal
 * supersession and manual resolution of other conflicts.
 *
 * @module consolidation/conflict-detector
 */

import { QUARANTINE_TAG, type MemoryStore } from '../interfaces/memory-store.js';
import type { MemoryIndex } from '../interfaces/memory-index.js';
import type { SemanticFact } from '../schemas/semantic.js';

export interface Conflict {
  factA: SemanticFact;
  factB: SemanticFact;
  type: 'negation' | 'supersession' | 'semantic_contradiction';
  confidence: number;
}

export type ConflictResolutionPolicy = 'supersede-on-newer' | 'negation-invalidates-positive' | 'manual-review';

export interface ConflictResolutionReport {
  resolved: number;
  skipped: number;
  details: Array<{ conflict: Conflict; action: string }>;
}

export interface ConflictDetectorOptions {
  /**
   * Auto-resolve temporal supersession as a side effect of {@link
   * ConflictDetector.detectConflicts} (default: **false**).
   *
   * Detection is read-only by default: a "detect" method must not mutate the
   * store. When enabled, `detectConflicts` invalidates the older fact of each
   * superseding pair inline — but the recommended flow is to leave this off and
   * resolve explicitly via {@link ConflictDetector.autoResolveAll}, so callers
   * see the conflicts before any write happens.
   */
  autoResolveSupersession?: boolean;
  /** Cosine similarity threshold for contradiction detection (default: 0.8). */
  embeddingThreshold?: number;
  /** Word overlap threshold below which facts may be contradictory (default: 0.3). */
  semanticOverlapThreshold?: number;
  /** Default conflict resolution policy. */
  policy?: ConflictResolutionPolicy;
  /** Minimum time difference in days for supersession detection (default: 1). */
  supersessionDayThreshold?: number;
  /** Batch size for paginated fact loading (default: 1000). */
  batchSize?: number;
}

/** Common English stop words to exclude from word overlap analysis. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'and',
  'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
  'that', 'this', 'these', 'those', 'it', 'its',
]);

/** Negation keywords. */
const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'neither', 'nor', 'cannot',
]);

/** Negation contractions (lowercased). */
const NEGATION_CONTRACTIONS = [
  "doesn't", "don't", "isn't", "wasn't", "hasn't",
  "won't", "can't", "couldn't", "wouldn't", "shouldn't",
  "aren't", "weren't", "haven't", "hadn't",
  "doesnt", "dont", "isnt", "wasnt", "hasnt",
  "wont", "cant", "couldnt", "wouldnt", "shouldnt",
  "arent", "werent", "havent", "hadnt",
  "no longer",
];

export class ConflictDetector {
  constructor(
    private readonly store: MemoryStore,
    private readonly index: MemoryIndex,
    private readonly options: ConflictDetectorOptions = {},
  ) {}

  async detectConflicts(facts?: SemanticFact[]): Promise<Conflict[]> {
    const allFacts = facts ?? await this.loadActiveFacts();
    const activeFacts = allFacts.filter((f) => !f.invalidated_by);
    const conflicts: Conflict[] = [];
    const pairKeys = new Set<string>();

    const makePairKey = (a: string, b: string): string =>
      a < b ? `${a}:${b}` : `${b}:${a}`;

    // Group facts by entity_id for efficient pair generation
    const byEntity = new Map<string, SemanticFact[]>();
    for (const fact of activeFacts) {
      for (const eid of fact.entity_ids) {
        let group = byEntity.get(eid);
        if (!group) {
          group = [];
          byEntity.set(eid, group);
        }
        group.push(fact);
      }
    }

    // 1. Negation detection
    for (const [, group] of byEntity) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const pk = makePairKey(a.id, b.id);
          if (pairKeys.has(pk)) continue;

          if (this.isNegation(a, b)) {
            pairKeys.add(pk);
            conflicts.push({ factA: a, factB: b, type: 'negation', confidence: 0.8 });
          }
        }
      }
    }

    // 2. Temporal supersession. Detection is read-only by default; resolution
    // happens only when a caller explicitly opts in (see the option docs).
    const autoResolve = this.options.autoResolveSupersession ?? false;
    for (const [, group] of byEntity) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const pk = makePairKey(a.id, b.id);
          if (pairKeys.has(pk)) continue;

          const supersession = this.checkSupersession(a, b);
          if (supersession) {
            pairKeys.add(pk);
            conflicts.push(supersession);

            if (autoResolve) {
              // Invalidate the older fact
              const older = a.valid_from < b.valid_from ? a : b;
              const newer = older === a ? b : a;
              await this.store.putFact({
                ...older,
                invalidated_by: newer.id,
              });
            }
          }
        }
      }
    }

    // 3. Semantic contradiction (embedding-based)
    const embeddingThreshold = this.options.embeddingThreshold ?? 0.8;
    for (const fact of activeFacts) {
      if (!fact.embedding) continue;

      const similar = await this.index.searchFacts(fact.embedding, {
        minSimilarity: embeddingThreshold,
        limit: 50,
      });

      for (const { item: candidate } of similar) {
        if (candidate.id === fact.id) continue;
        if (candidate.invalidated_by) continue;
        // The index holds all facts (incl. quarantined); a poisoned fact must
        // not generate conflicts against trusted ones.
        if ((candidate.tags ?? []).includes(QUARANTINE_TAG)) continue;

        const pk = makePairKey(fact.id, candidate.id);
        if (pairKeys.has(pk)) continue;

        // Must share at least one entity_id
        const sharedEntities = fact.entity_ids.some((eid) =>
          candidate.entity_ids.includes(eid),
        );
        if (!sharedEntities) continue;

        // Low text overlap => potential contradiction
        const overlapThreshold = this.options.semanticOverlapThreshold ?? 0.3;
        const overlap = this.wordOverlap(fact.content, candidate.content);
        if (overlap < overlapThreshold) {
          // Scale confidence by content length: short facts are more likely
          // genuine contradictions; longer facts with low overlap are often
          // complementary rather than contradictory.
          const wordsA = this.tokenize(fact.content);
          const wordsB = this.tokenize(candidate.content);
          const minWords = Math.min(wordsA.length, wordsB.length);
          const confidence = minWords <= 4 ? 0.7 : minWords <= 8 ? 0.5 : 0.3;

          pairKeys.add(pk);
          conflicts.push({
            factA: fact,
            factB: candidate,
            type: 'semantic_contradiction',
            confidence,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Batch-load every active, non-quarantined fact (same paging pattern as
   * MemoryConsolidator / evaluateRetention). A single capped fetch would
   * silently exclude facts past the cap from conflict detection.
   */
  private async loadActiveFacts(): Promise<SemanticFact[]> {
    const batchSize = this.options.batchSize ?? 1000;
    const facts: SemanticFact[] = [];
    let offset = 0;
    while (true) {
      const batch = await this.store.findFacts({
        includeInvalidated: false,
        excludeTags: [QUARANTINE_TAG],
        limit: batchSize,
        offset,
      });
      facts.push(...batch);
      if (batch.length < batchSize) break;
      offset += batchSize;
    }
    return facts;
  }

  async resolveConflict(
    conflict: Conflict,
    resolution: 'keep_a' | 'keep_b' | 'keep_both',
  ): Promise<void> {
    if (resolution === 'keep_a') {
      await this.store.putFact({
        ...conflict.factB,
        invalidated_by: conflict.factA.id,
      });
    } else if (resolution === 'keep_b') {
      await this.store.putFact({
        ...conflict.factA,
        invalidated_by: conflict.factB.id,
      });
    }
    // 'keep_both' — no action
  }

  async autoResolveAll(
    conflicts: Conflict[],
    policy?: ConflictResolutionPolicy,
  ): Promise<ConflictResolutionReport> {
    const effectivePolicy = policy ?? this.options.policy ?? 'manual-review';
    const report: ConflictResolutionReport = {
      resolved: 0,
      skipped: 0,
      details: [],
    };

    for (const conflict of conflicts) {
      if (effectivePolicy === 'manual-review') {
        report.skipped++;
        report.details.push({ conflict, action: 'skipped: manual review required' });
        continue;
      }

      if (effectivePolicy === 'supersede-on-newer') {
        const resolution = this.resolveByTemporal(conflict);
        await this.resolveConflict(conflict, resolution.keep);
        report.resolved++;
        report.details.push({ conflict, action: resolution.action });
        continue;
      }

      if (effectivePolicy === 'negation-invalidates-positive') {
        if (conflict.type === 'negation') {
          // Respect temporal order first: a newer positive correction ("X is
          // now safe") must survive a stale negation ("X is not safe"), and a
          // newer negation still invalidates an older positive. Only when the
          // two share a timestamp does the policy's negation bias break the tie
          // — otherwise a stale negation could silently kill a later fix.
          const aTime = conflict.factA.valid_from.getTime();
          const bTime = conflict.factB.valid_from.getTime();
          let keep: 'keep_a' | 'keep_b';
          let action: string;
          if (aTime !== bTime) {
            keep = aTime > bTime ? 'keep_a' : 'keep_b';
            action = 'newer fact kept, older fact invalidated';
          } else {
            keep = this.containsNegation(conflict.factA.content) ? 'keep_a' : 'keep_b';
            action = 'same timestamp: negation kept, positive fact invalidated';
          }
          await this.resolveConflict(conflict, keep);
          report.resolved++;
          report.details.push({ conflict, action });
        } else if (conflict.type === 'supersession') {
          const resolution = this.resolveByTemporal(conflict);
          await this.resolveConflict(conflict, resolution.keep);
          report.resolved++;
          report.details.push({ conflict, action: resolution.action });
        } else {
          // semantic_contradiction
          report.skipped++;
          report.details.push({ conflict, action: 'requires manual review' });
        }
      }
    }

    return report;
  }

  private resolveByTemporal(conflict: Conflict): { keep: 'keep_a' | 'keep_b'; action: string } {
    const aTime = conflict.factA.valid_from.getTime();
    const bTime = conflict.factB.valid_from.getTime();

    if (aTime !== bTime) {
      if (aTime > bTime) {
        return { keep: 'keep_a', action: 'newer fact kept, older fact invalidated' };
      } else {
        return { keep: 'keep_b', action: 'newer fact kept, older fact invalidated' };
      }
    }

    // Same valid_from: tiebreak by ID (lexicographic, keep smaller)
    if (conflict.factA.id < conflict.factB.id) {
      return { keep: 'keep_a', action: 'same timestamp, kept lexicographically smaller ID' };
    } else {
      return { keep: 'keep_b', action: 'same timestamp, kept lexicographically smaller ID' };
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  }

  private containsNegation(text: string): boolean {
    const lower = text.toLowerCase();

    for (const contraction of NEGATION_CONTRACTIONS) {
      if (lower.includes(contraction)) return true;
    }

    const words = lower.split(/\s+/);
    for (const w of words) {
      if (NEGATION_WORDS.has(w)) return true;
    }

    return false;
  }

  private wordOverlap(textA: string, textB: string): number {
    const wordsA = new Set(this.tokenize(textA));
    const wordsB = new Set(this.tokenize(textB));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let shared = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) shared++;
    }

    return shared / Math.min(wordsA.size, wordsB.size);
  }

  private wordOverlapExcludingNegations(textA: string, textB: string): number {
    const filterNeg = (words: string[]) =>
      words.filter((w) => !NEGATION_WORDS.has(w) && !NEGATION_CONTRACTIONS.includes(w));

    const wordsA = new Set(filterNeg(this.tokenize(textA)));
    const wordsB = new Set(filterNeg(this.tokenize(textB)));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let shared = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) shared++;
    }

    return shared / Math.min(wordsA.size, wordsB.size);
  }

  private isNegation(a: SemanticFact, b: SemanticFact): boolean {
    const aHasNeg = this.containsNegation(a.content);
    const bHasNeg = this.containsNegation(b.content);

    // Exactly one should contain negation
    if (aHasNeg === bHasNeg) return false;

    // Check high word overlap excluding negation words (>50%)
    const overlap = this.wordOverlapExcludingNegations(a.content, b.content);
    return overlap > 0.5;
  }

  private checkSupersession(a: SemanticFact, b: SemanticFact): Conflict | null {
    const timeDiffMs = Math.abs(a.valid_from.getTime() - b.valid_from.getTime());
    const thresholdDays = this.options.supersessionDayThreshold ?? 1;
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

    if (timeDiffMs <= thresholdMs) return null;

    // Normalize dates/timestamps for content comparison while preserving
    // semantically meaningful numbers (e.g., "3 children", "100 employees")
    const normalizeForComparison = (text: string) =>
      text.replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, '').replace(/\d{1,2}:\d{2}(?::\d{2})?/g, '').replace(/\s+/g, ' ').trim();

    const cleanA = normalizeForComparison(a.content);
    const cleanB = normalizeForComparison(b.content);
    const overlap = this.wordOverlap(cleanA, cleanB);

    if (overlap <= 0.4) return null;

    return {
      factA: a,
      factB: b,
      type: 'supersession',
      confidence: 0.9,
    };
  }
}

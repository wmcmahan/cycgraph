/**
 * Rule-Based Multi-Fact Extractor
 *
 * Sentence-level pattern matching to extract atomic facts, entities,
 * and relationships from episodes. Produces multiple facts per episode
 * unlike the simple extractor which produces only one.
 *
 * @module hierarchy/rule-based-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Entity } from '../schemas/entity.js';
import type { Relationship } from '../schemas/relationship.js';
import type { SemanticExtractor, ExtractionResult } from '../interfaces/semantic-extractor.js';

export interface RuleBasedExtractorOptions {
  /** Skip sentences shorter than this (default: 20 chars). */
  minSentenceLength?: number;
  /** Additional entity-detection regexes. */
  entityPatterns?: RegExp[];
  /**
   * Additional relationship verbs. Note: the inflection engine handles
   * regular verbs only. Consonant-doubling verbs (e.g., "stop" → "stopped")
   * are not supported — use pre-inflected forms or the base form.
   */
  relationshipVerbs?: string[];
}

export interface ExtractedEntity {
  name: string;
  type: string;
}

const DEFAULT_RELATIONSHIP_VERBS = [
  'work_at', 'report_to', 'manage', 'lead', 'create',
  'author', 'own', 'use', 'depend_on', 'contain',
  'belong_to', 'collaborate_with', 'review', 'approve',
  'deploy', 'test', 'maintain', 'support', 'block', 'require',
  // Common relationship verbs from natural news/report prose — added after
  // the 2026-07 implementation-blind baseline measured 0/20 assertion
  // capture on natural text (acquisitions, appointments, funding, hiring
  // were all invisible). 'found' is deliberately absent: it collides with
  // the past tense of 'find' ("found the bug") and would fabricate edges.
  'acquire', 'appoint', 'replace', 'succeed', 'fund', 'sponsor',
  'open', 'sign', 'chair', 'join', 'hire', 'launch', 'publish',
  'serve', 'advise', 'invest_in', 'partner_with',
];

/**
 * Map base verb to inflected forms for regex matching.
 * Returns forms like: work, works, worked, working
 */
function verbForms(verb: string): string[] {
  // verb may be like "works_at" — split on underscore, inflect first word
  const parts = verb.split('_');
  const base = parts[0];
  const rest = parts.slice(1).join(' ');

  const forms: string[] = [];

  // Add the base form and common inflections
  forms.push(base);
  if (base.endsWith('e')) {
    forms.push(base + 's');
    forms.push(base + 'd');
    forms.push(base.slice(0, -1) + 'ing');
  } else if (base.endsWith('y') && !/[aeiou]y$/.test(base)) {
    forms.push(base.slice(0, -1) + 'ies');
    forms.push(base.slice(0, -1) + 'ied');
    forms.push(base + 'ing');
  } else {
    forms.push(base + 's');
    forms.push(base + 'ed');
    forms.push(base + 'ing');
  }

  // Build full forms with the rest of the verb phrase
  if (rest) {
    return forms.map((f) => f + ' ' + rest);
  }
  return forms;
}

/** Days and months — capitalized, but not entities. */
const TEMPORAL_WORDS = new Set([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

/**
 * Honorifics and title fragments — never standalone entities. Left attached
 * inside multi-word names ("Chef Rosa Delgado"), but a bare "Dr" entity
 * interposes between real endpoints and steals relationship attribution
 * ("appointed Dr. Marcus Webb" paired the org with "Dr").
 */
const TITLE_WORDS = new Set([
  'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Rev', 'Jr', 'Sr', 'St',
]);

// Org-name cue words, matched anywhere in a multi-word name. Expanded after
// the 2026-07 implementation-blind baseline measured 0.348 type accuracy —
// "Medical Center", "University", "FC", "Consortium" etc. were all typed as
// persons under the original short suffix list.
const ORG_SUFFIXES = new RegExp(
  '\\b(?:Corp|Inc|Ltd|LLC|Co|Group|Foundation|Institute|Association' +
  '|University|College|School|Hospital|Center|Centre|Clinic|Medical' +
  '|Consortium|Labs?|Council|Committee|Commission|Agency|Authority' +
  '|Department|Ministry|Bureau|Journal|Press|Museum|Society|Union' +
  '|Bank|Capital|Partners|Holdings|Ventures|Industries|Systems' +
  '|Technologies|Solutions|Services|Networks|Studios|Team' +
  '|FC|SC|AFC|United|City|Grocers|Motors|Airlines|Railway)\\b',
  'i',
);

/**
 * Negation markers that invert a verb's meaning. A verb form found between
 * two entities must NOT produce a relationship when the same span negates it
 * ("never worked at", "does not manage") — the graph would record the
 * opposite of what the sentence says. The fact still captures the full
 * sentence; only the affirmative edge is suppressed.
 */
const NEGATION_BETWEEN = /(?<![a-z])(?:not|no|never|cannot|neither|nor|without)(?![a-z])|n't(?![a-z])/;

export class RuleBasedExtractor implements SemanticExtractor {
  private readonly minSentenceLength: number;
  private readonly extraEntityPatterns: RegExp[];
  private readonly relationshipVerbs: string[];
  private readonly verbFormMap: Map<string, { canonical: string; pattern: RegExp }>;

  constructor(options?: RuleBasedExtractorOptions) {
    this.minSentenceLength = options?.minSentenceLength ?? 20;
    this.extraEntityPatterns = options?.entityPatterns ?? [];
    this.relationshipVerbs = [
      ...DEFAULT_RELATIONSHIP_VERBS,
      ...(options?.relationshipVerbs ?? []),
    ];

    // Pre-build a map from each inflected form to the canonical verb, with a
    // word-boundary pattern per form. Substring matching would hallucinate
    // relationships from embedded stems: "use" inside "because"/"causes",
    // "lead" inside "misleading", "own" inside "down".
    this.verbFormMap = new Map();
    for (const verb of this.relationshipVerbs) {
      for (const form of verbForms(verb)) {
        const lower = form.toLowerCase();
        const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        this.verbFormMap.set(lower, {
          canonical: verb,
          pattern: new RegExp(`(?<![a-z])${escaped}(?![a-z])`),
        });
      }
    }
  }

  async extract(episode: Episode): Promise<ExtractionResult> {
    const now = new Date();
    const entityNameToId = new Map<string, string>();
    const entityNameToType = new Map<string, string>();
    const seenNormalized = new Set<string>();
    const facts: SemanticFact[] = [];
    const relationships: Relationship[] = [];

    for (const message of episode.messages) {
      const sentences = splitSentences(message.content);

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length < this.minSentenceLength) continue;

        const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
        if (seenNormalized.has(normalized)) continue;
        seenNormalized.add(normalized);

        const detectedEntities = this.extractEntities(trimmed);
        const entityIds = detectedEntities.map((e) => {
          if (!entityNameToId.has(e.name)) {
            entityNameToId.set(e.name, crypto.randomUUID());
            entityNameToType.set(e.name, e.type);
          }
          return entityNameToId.get(e.name)!;
        });

        facts.push({
          id: crypto.randomUUID(),
          content: trimmed,
          source_episode_ids: [episode.id],
          entity_ids: entityIds,
          provenance: {
            source: 'derived',
            created_at: now,
          },
          valid_from: episode.started_at,
          tags: [],
        });

        // Extract relationships between detected entities in this sentence
        const sentenceRels = this.extractRelationships(
          trimmed, detectedEntities, entityNameToId, episode.started_at, now,
        );
        relationships.push(...sentenceRels);
      }
    }

    // Build Entity records from the name→id map
    const entities: Entity[] = [...entityNameToId.entries()].map(([name, id]) => ({
      id,
      name,
      entity_type: entityNameToType.get(name) ?? 'concept',
      attributes: {},
      provenance: { source: 'derived' as const, created_at: now },
      created_at: now,
      updated_at: now,
    }));

    // Episode → facts back-link (the schema's `fact_ids` contract) —
    // callers persist the episode after extraction.
    episode.fact_ids = facts.map((f) => f.id);

    return { facts, entities, relationships };
  }

  /**
   * Scan a sentence for verb patterns between known entities.
   * Looks for `<entityA> ... <verb> ... <entityB>` patterns.
   */
  private extractRelationships(
    sentence: string,
    detectedEntities: ExtractedEntity[],
    entityNameToId: Map<string, string>,
    validFrom: Date,
    now: Date,
  ): Relationship[] {
    if (detectedEntities.length < 2) return [];

    const relationships: Relationship[] = [];
    const lowerSentence = sentence.toLowerCase();

    // Find the position of each entity in the sentence using word-boundary matching
    const entityPositions = detectedEntities
      .map((e) => {
        const escaped = e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = sentence.match(new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`));
        return { entity: e, index: match?.index ?? -1 };
      })
      .filter((ep) => ep.index >= 0)
      .sort((a, b) => a.index - b.index);

    // For each adjacent entity pair, look for verb forms between them
    for (let i = 0; i < entityPositions.length - 1; i++) {
      const source = entityPositions[i];
      const target = entityPositions[i + 1];

      const between = lowerSentence.slice(
        source.index + source.entity.name.length,
        target.index,
      );

      // A negated span never yields an affirmative edge.
      if (NEGATION_BETWEEN.test(between)) continue;

      for (const [, { canonical, pattern }] of this.verbFormMap) {
        if (pattern.test(between)) {
          const sourceId = entityNameToId.get(source.entity.name);
          const targetId = entityNameToId.get(target.entity.name);
          if (sourceId && targetId) {
            relationships.push({
              id: crypto.randomUUID(),
              source_id: sourceId,
              target_id: targetId,
              relation_type: canonical,
              weight: 1,
              attributes: {},
              valid_from: validFrom,
              provenance: { source: 'derived' as const, created_at: now },
            });
          }
          break; // One relationship per entity pair
        }
      }
    }

    return relationships;
  }

  /** Expose entity extraction for reuse by other components. */
  extractEntities(text: string): ExtractedEntity[] {
    const entities = new Map<string, ExtractedEntity>();

    // Capitalized multi-word names: "Alice Smith", "Acme Corp", "Tech LLC"
    const multiWordPattern = /\b[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}))+\b/g;
    for (const match of text.matchAll(multiWordPattern)) {
      const name = match[0];
      const type = ORG_SUFFIXES.test(name) ? 'organization' : 'person';
      entities.set(name, { name, type });
    }

    // Single capitalized words NOT at sentence start. Days and months are
    // excluded: they are capitalized but almost never useful entities, and
    // as detected entities they interpose between real endpoints and steal
    // relationship attribution in the adjacent-pair scan ("said on Tuesday
    // that it has acquired…" paired Tuesday, not the acquirer).
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      // Strip a possessive before cleaning, so "Meridian's" yields
      // "Meridian" rather than the mangled "Meridians".
      const word = words[i].replace(/[’']s$/, '').replace(/[^a-zA-Z]/g, '');
      if (TEMPORAL_WORDS.has(word) || TITLE_WORDS.has(word)) continue;
      if (word.length >= 2 && /^[A-Z][a-z]+$/.test(word)) {
        // Skip if already a WORD of a multi-word entity. Word-level, not
        // substring: "Annual Report" must not suppress the person "Ann".
        const alreadyCovered = [...entities.keys()].some((k) =>
          k.split(/\s+/).includes(word),
        );
        if (!alreadyCovered) {
          entities.set(word, { name: word, type: 'concept' });
        }
      }
    }

    // @-handles
    const handlePattern = /@\w+/g;
    for (const match of text.matchAll(handlePattern)) {
      entities.set(match[0], { name: match[0], type: 'person' });
    }

    // Quoted terms (double quotes)
    const dblQuotePattern = /"([^"]+)"/g;
    for (const match of text.matchAll(dblQuotePattern)) {
      entities.set(match[1], { name: match[1], type: 'concept' });
    }

    // Quoted terms (single quotes). Boundary lookarounds keep possessive
    // apostrophes from opening phantom spans: in "Bluefin's … Meridian's",
    // the bare pattern matched the text BETWEEN the two possessives as a
    // quoted term.
    const sglQuotePattern = /(?<![a-zA-Z])'([^']+)'(?![a-zA-Z])/g;
    for (const match of text.matchAll(sglQuotePattern)) {
      entities.set(match[1], { name: match[1], type: 'concept' });
    }

    // camelCase identifiers
    const camelPattern = /\b[a-z]+[A-Z]\w*/g;
    for (const match of text.matchAll(camelPattern)) {
      entities.set(match[0], { name: match[0], type: 'concept' });
    }

    // ACRONYMS (2+ uppercase letters)
    const acronymPattern = /\b[A-Z]{2,}\b/g;
    for (const match of text.matchAll(acronymPattern)) {
      entities.set(match[0], { name: match[0], type: 'concept' });
    }

    // Additional user-supplied patterns
    for (const pattern of this.extraEntityPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (const match of text.matchAll(regex)) {
        const name = match[1] ?? match[0];
        entities.set(name, { name, type: 'concept' });
      }
    }

    return [...entities.values()];
  }
}

/**
 * Split text into sentences, preserving common abbreviations.
 */
function splitSentences(text: string): string[] {
  // Replace common abbreviations to avoid false splits
  const preserved = text
    .replace(/\b(Dr|Mr|Mrs|Ms|Jr|Sr|Prof|e\.g|i\.e|etc|vs|approx)\./gi, '$1\u0000');

  // Split on sentence-ending punctuation followed by whitespace or end
  const raw = preserved.split(/(?<=[.!?])\s+|(?<=[.!?])$/);

  return raw
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter((s) => s.length > 0);
}

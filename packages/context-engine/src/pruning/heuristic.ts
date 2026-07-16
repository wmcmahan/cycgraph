/**
 * Heuristic Token Scorer
 *
 * Rule-based importance scoring using six weighted heuristics.
 * No ML required — pure TypeScript string analysis.
 *
 * Rules:
 * 1. Stop word penalty (common words score low)
 * 2. Redundant phrasing (filler phrases score zero)
 * 3. Position boost (first/last 10% score high)
 * 4. Frequency penalty (cross-segment repetition penalized)
 * 5. Named entity boost (capitalized words, numbers, URLs score high)
 * 6. Structural marker boost (headers, list markers, key-value colons)
 *
 * @module pruning/heuristic
 */

import type { ScoredToken, TokenScorer, ScorerContext } from './types.js';
import type { CompressionStage } from '../pipeline/types.js';
import { createPruningStage } from './pruner.js';

// ─── Configuration ────────────────────────────────────────────────

export interface HeuristicScorerOptions {
  /** Weight for stop word penalty (default 0.25). */
  stopWordWeight?: number;
  /** Weight for redundant phrasing penalty (default 0.15). */
  fillerWeight?: number;
  /** Weight for position boost (default 0.15). */
  positionWeight?: number;
  /** Weight for frequency penalty (default 0.20). */
  frequencyWeight?: number;
  /** Weight for named entity boost (default 0.15). */
  entityWeight?: number;
  /** Weight for structural marker boost (default 0.10). */
  structuralWeight?: number;
  /** Weight for query relevance boost (default 0.20). */
  queryWeight?: number;
  /** Additional stop words to include. */
  customStopWords?: string[];
  /** Additional filler phrases to include. */
  customFillerPhrases?: string[];
}

// ─── Stop Words ───────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'this',
  'that', 'these', 'those', 'it', 'its', 'not', 'no', 'so', 'if',
  'then', 'than', 'very', 'just', 'about', 'also', 'more', 'some',
  'any', 'each', 'every', 'all', 'both', 'few', 'most', 'other',
  'into', 'over', 'after', 'before', 'between', 'under', 'above',
  'up', 'down', 'out', 'off', 'again', 'further', 'once', 'here',
  'there', 'when', 'where', 'why', 'how', 'which', 'who', 'whom',
  'what', 'while', 'during', 'through', 'because', 'since', 'until',
  'although', 'though', 'whether', 'either', 'neither', 'yet', 'still',
  'already', 'even', 'much', 'many', 'such', 'only', 'own', 'same',
  'too', 'quite', 'rather', 'enough', 'well', 'back', 'now', 'then',
  'however', 'therefore', 'thus', 'hence', 'moreover', 'furthermore',
  'additionally', 'meanwhile', 'nevertheless', 'nonetheless', 'instead',
  'otherwise', 'regardless', 'accordingly', 'consequently', 'specifically',
  'particularly', 'essentially', 'basically', 'generally', 'typically',
  'usually', 'often', 'sometimes', 'always', 'never', 'perhaps',
  'probably', 'certainly', 'definitely', 'simply', 'merely', 'actually',
  'really', 'truly', 'clearly', 'obviously', 'apparently', 'seemingly',
]);

// ─── Negations (never pruned) ─────────────────────────────────────

/**
 * Closed-class negation/polarity words. Several also appear in STOP_WORDS
 * (so they still score low for ranking), but they must never be *dropped*:
 * removing "not" from "do not delete the database" inverts the meaning. The
 * scorer marks these `protected` so the pruner keeps them regardless of budget.
 * Matched case-insensitively on the token with surrounding punctuation stripped.
 */
const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'none', 'neither', 'nor', 'without', 'cannot',
  "can't", "cant", "don't", "dont", "doesn't", "doesnt", "didn't", "didnt",
  "won't", "wont", "wouldn't", "wouldnt", "shouldn't", "shouldnt",
  "couldn't", "couldnt", "isn't", "isnt", "aren't", "arent", "wasn't",
  "wasnt", "weren't", "werent", "hasn't", "hasnt", "haven't", "havent",
  "hadn't", "hadnt", 'nothing', 'nobody', 'nowhere',
]);

/** Whether a raw token (with edge punctuation) is a negation word. */
function isNegation(trimmed: string): boolean {
  const normalized = trimmed.toLowerCase().replace(/^[^\w']+|[^\w']+$/g, '');
  return NEGATION_WORDS.has(normalized);
}

// ─── Filler Phrases ───────────────────────────────────────────────

const FILLER_PHRASES = [
  'in order to',
  'it should be noted that',
  'it is important to note that',
  'it is worth mentioning that',
  'as a matter of fact',
  'for the purpose of',
  'with respect to',
  'in terms of',
  'on the other hand',
  'at the end of the day',
  'as previously mentioned',
  'it goes without saying',
  'needless to say',
  'in the event that',
  'due to the fact that',
  'in light of the fact that',
  'for all intents and purposes',
  'at this point in time',
  'in the process of',
  'with regard to',
];

// ─── Pattern Detection ────────────────────────────────────────────

const ENTITY_PATTERNS = [
  /^[A-Z][a-z]+$/, // Capitalized word (Alice, Acme)
  /^\d[\d.,]*$/, // Numbers (42, 3.14, 1,000)
  /^\d{4}-\d{2}/, // Dates (2026-04-05)
  /^https?:\/\//, // URLs
  /^[a-z]+[A-Z]/, // camelCase
  /^[a-z]+_[a-z]+/, // snake_case
  /^[A-Z]{2,}$/, // ACRONYMS
  /^[A-Z][A-Z0-9-]+$/, // Uppercase identifiers (MERIDIAN-7, SOC-2, GPT-4)
  /^@\w+/, // @handles or @headers
  /^\$[\d.,]+/, // Dollar amounts
];

const STRUCTURAL_PATTERNS = [
  /^#{1,6}\s/, // Markdown headers
  /^[-*+]\s/, // List markers
  /^```/, // Code fences
  /^\d+\.\s/, // Numbered lists
  /:\s*$/, // Key-value colons (trailing)
  /^>\s/, // Blockquotes
];

// ─── Scorer Implementation ────────────────────────────────────────

/**
 * Create a heuristic token scorer with configurable weights.
 */
export function createHeuristicScorer(options?: HeuristicScorerOptions): TokenScorer {
  const baseWeights = {
    stopWord: options?.stopWordWeight ?? 0.25,
    filler: options?.fillerWeight ?? 0.15,
    position: options?.positionWeight ?? 0.15,
    frequency: options?.frequencyWeight ?? 0.20,
    entity: options?.entityWeight ?? 0.15,
    structural: options?.structuralWeight ?? 0.10,
  };

  const queryWeight = options?.queryWeight ?? 0.20;

  const stopWords = new Set([...STOP_WORDS, ...(options?.customStopWords ?? [])]);
  const fillerPhrases = [...FILLER_PHRASES, ...(options?.customFillerPhrases ?? [])];

  return {
    score(content: string, context?: ScorerContext): ScoredToken[] {
      // Mark filler phrase regions
      const fillerRanges = findFillerRanges(content, fillerPhrases);

      // Build cross-segment frequency map
      const freqMap = buildFrequencyMap(content, context?.allContent);

      // Split preserving whitespace
      const parts = content.split(/(\s+)/);
      const totalParts = parts.length;

      // Determine if query is active
      const query = context?.query;
      const hasQuery = query != null && query.trim().length > 0;
      const queryTerms = hasQuery ? tokenizeQuery(query!, stopWords) : new Set<string>();

      // When query is present, scale base weights down to make room for queryWeight
      const scaleFactor = hasQuery ? (1 - queryWeight) : 1;
      const weights = {
        stopWord: baseWeights.stopWord * scaleFactor,
        filler: baseWeights.filler * scaleFactor,
        position: baseWeights.position * scaleFactor,
        frequency: baseWeights.frequency * scaleFactor,
        entity: baseWeights.entity * scaleFactor,
        structural: baseWeights.structural * scaleFactor,
        query: hasQuery ? queryWeight : 0,
      };

      return parts.map((text, offset) => {
        const trimmed = text.trim();

        // Whitespace tokens: neutral score
        if (trimmed === '') {
          return { text, score: 0.5, offset };
        }

        // Negations must never be pruned — dropping "not"/"never" inverts
        // meaning. Keep them protected and score high so order is preserved.
        if (isNegation(trimmed)) {
          return { text, score: 1.0, offset, protected: true };
        }

        // Check if inside a filler phrase range
        const charPos = parts.slice(0, offset).join('').length;
        const inFiller = fillerRanges.some(([start, end]) => charPos >= start && charPos < end);

        // Compute sub-scores
        const stopScore = stopWords.has(trimmed.toLowerCase()) ? 0.1 : 0.7;
        const fillerScore = inFiller ? 0.0 : 0.7;
        const positionScore = computePositionScore(offset, totalParts);
        const freqScore = computeFrequencyScore(trimmed.toLowerCase(), freqMap);
        const entityScore = isEntity(trimmed) ? 0.95 : 0.5;
        const structuralScore = isStructuralMarker(text) ? 0.95 : 0.5;

        // Query relevance score
        const queryScore = hasQuery
          ? computeQueryRelevance(parts, offset, queryTerms, stopWords)
          : 0.5;

        // Weighted average
        const score = (
          stopScore * weights.stopWord +
          fillerScore * weights.filler +
          positionScore * weights.position +
          freqScore * weights.frequency +
          entityScore * weights.entity +
          structuralScore * weights.structural +
          queryScore * weights.query
        );

        return { text, score, offset };
      });
    },
  };
}

/**
 * Create a pipeline stage that applies heuristic pruning.
 */
export function createHeuristicPruningStage(options?: HeuristicScorerOptions): CompressionStage {
  const scorer = createHeuristicScorer(options);
  const stage = createPruningStage(scorer);
  return { ...stage, name: 'heuristic-pruning' };
}

// ─── Helper Functions ─────────────────────────────────────────────

function findFillerRanges(content: string, phrases: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  const lower = content.toLowerCase();
  for (const phrase of phrases) {
    let idx = 0;
    while ((idx = lower.indexOf(phrase, idx)) !== -1) {
      ranges.push([idx, idx + phrase.length]);
      idx += phrase.length;
    }
  }
  return ranges;
}

function buildFrequencyMap(
  content: string,
  allContent?: string[],
): Map<string, number> {
  const sources = allContent ?? [content];
  const wordSets = sources.map(c =>
    new Set(c.toLowerCase().split(/\s+/).filter(w => w.length > 0)),
  );

  const freq = new Map<string, number>();
  for (const wordSet of wordSets) {
    for (const word of wordSet) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  return freq;
}

function computePositionScore(offset: number, total: number): number {
  if (total === 0) return 0.5;
  const position = offset / total;
  // First and last 10% get boosted
  if (position < 0.1 || position > 0.9) return 0.9;
  return 0.5;
}

function computeFrequencyScore(word: string, freqMap: Map<string, number>): number {
  const total = freqMap.size;
  if (total === 0) return 0.5;
  const freq = freqMap.get(word) ?? 0;
  // Words appearing in many segments are less informative
  return Math.max(0.1, 1.0 - (freq / Math.max(total, 1)));
}

function isEntity(word: string): boolean {
  return ENTITY_PATTERNS.some(pattern => pattern.test(word));
}

function isStructuralMarker(text: string): boolean {
  return STRUCTURAL_PATTERNS.some(pattern => pattern.test(text));
}

// ─── Query Relevance ─────────────────────────────────────────────

/**
 * Tokenize a query string into meaningful terms, removing stop words.
 */
function tokenizeQuery(query: string, stopWords: Set<string>): Set<string> {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().split(/\s+/)) {
    const cleaned = word.replace(/[^\w]/g, '');
    if (cleaned.length > 0 && !stopWords.has(cleaned)) {
      terms.add(cleaned);
    }
  }
  return terms;
}

/**
 * Compute query relevance for a token via Jaccard overlap between
 * the token's local context window (5 tokens before/after) and query terms.
 */
function computeQueryRelevance(
  parts: string[],
  offset: number,
  queryTerms: Set<string>,
  stopWords: Set<string>,
): number {
  if (queryTerms.size === 0) return 0.5;

  // Gather context window tokens (5 before, current, 5 after)
  const windowStart = Math.max(0, offset - 10); // *2 because parts include whitespace
  const windowEnd = Math.min(parts.length, offset + 11);
  const contextTerms = new Set<string>();

  for (let i = windowStart; i < windowEnd; i++) {
    const trimmed = parts[i].trim().toLowerCase().replace(/[^\w]/g, '');
    if (trimmed.length > 0 && !stopWords.has(trimmed)) {
      contextTerms.add(trimmed);
    }
  }

  if (contextTerms.size === 0) return 0;

  // Jaccard overlap
  let intersection = 0;
  for (const term of queryTerms) {
    if (contextTerms.has(term)) intersection++;
  }

  const union = new Set([...queryTerms, ...contextTerms]).size;
  return union === 0 ? 0 : intersection / union;
}

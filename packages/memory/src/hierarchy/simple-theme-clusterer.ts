/**
 * Simple Theme Clusterer
 *
 * Greedy embedding-based clustering: assigns each fact to the most
 * similar existing theme (if above threshold) or creates a new one.
 * Falls back to a single "General" theme when no embeddings are present.
 *
 * @module hierarchy/simple-theme-clusterer
 */

import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';
import type { ThemeClusterer } from '../interfaces/theme-clusterer.js';
import { cosineSimilarity } from '../utils/similarity.js';

export interface SimpleThemeClustererOptions {
  /** Minimum similarity to assign a fact to an existing theme (default: 0.7). */
  similarityThreshold?: number;
}

/**
 * Write the fact → theme back-pointer for every fact in this batch, derived
 * from the final theme membership. The schema documents `theme_id` as
 * "assigned during clustering", and the retriever's entity/tag paths rely on
 * it to expand facts to their themes — callers persist the facts afterward.
 */
export function assignThemeIds(facts: SemanticFact[], themes: Theme[]): void {
  const factToTheme = new Map<string, string>();
  for (const theme of themes) {
    for (const factId of theme.fact_ids) {
      factToTheme.set(factId, theme.id);
    }
  }
  for (const fact of facts) {
    const themeId = factToTheme.get(fact.id);
    if (themeId !== undefined) fact.theme_id = themeId;
  }
}

export class SimpleThemeClusterer implements ThemeClusterer {
  private readonly similarityThreshold: number;

  constructor(opts: SimpleThemeClustererOptions = {}) {
    this.similarityThreshold = opts.similarityThreshold ?? 0.7;
  }

  async cluster(facts: SemanticFact[], existingThemes: Theme[] = []): Promise<Theme[]> {
    const themes = existingThemes.map((t) => ({ ...t, fact_ids: [...t.fact_ids] }));

    // Check if any facts have embeddings
    const factsWithEmbeddings = facts.filter((f) => f.embedding);
    if (factsWithEmbeddings.length === 0) {
      const result = this.fallbackSingleTheme(facts, themes);
      assignThemeIds(facts, result);
      return result;
    }

    for (const fact of facts) {
      if (!fact.embedding) {
        // No embedding — assign to fallback theme
        this.assignToFallbackTheme(fact, themes);
        continue;
      }

      // Find the most similar theme with an embedding
      let bestTheme: Theme | null = null;
      let bestScore = -1;

      for (const theme of themes) {
        if (!theme.embedding) continue;
        const score = cosineSimilarity(fact.embedding, theme.embedding);
        if (score > bestScore) {
          bestScore = score;
          bestTheme = theme;
        }
      }

      if (bestTheme && bestScore >= this.similarityThreshold) {
        bestTheme.fact_ids.push(fact.id);
      } else {
        // Create new theme from this fact
        themes.push({
          id: crypto.randomUUID(),
          label: fact.content.slice(0, 80),
          description: '',
          fact_ids: [fact.id],
          embedding: fact.embedding ? [...fact.embedding] : undefined,
          provenance: {
            source: 'system',
            created_at: new Date(),
          },
        });
      }
    }

    assignThemeIds(facts, themes);
    return themes;
  }

  private fallbackSingleTheme(facts: SemanticFact[], themes: Theme[]): Theme[] {
    // Find or create a "General" theme
    let general = themes.find((t) => t.label === 'General');
    if (!general) {
      general = {
        id: crypto.randomUUID(),
        label: 'General',
        description: 'Default theme for facts without embeddings',
        fact_ids: [],
        provenance: {
          source: 'system',
          created_at: new Date(),
        },
      };
      themes.push(general);
    }

    for (const fact of facts) {
      general.fact_ids.push(fact.id);
    }

    return themes;
  }

  private assignToFallbackTheme(fact: SemanticFact, themes: Theme[]): void {
    let general = themes.find((t) => t.label === 'General');
    if (!general) {
      general = {
        id: crypto.randomUUID(),
        label: 'General',
        description: 'Default theme for facts without embeddings',
        fact_ids: [],
        provenance: {
          source: 'system',
          created_at: new Date(),
        },
      };
      themes.push(general);
    }
    general.fact_ids.push(fact.id);
  }
}

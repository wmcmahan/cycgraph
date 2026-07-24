/**
 * Theme Clusterer Interface
 *
 * Groups semantic facts into thematic clusters.
 * Level 2 → Level 3 of the xMemory hierarchy.
 *
 * @module interfaces/theme-clusterer
 */

import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';

export interface ThemeClusterer {
  /**
   * Cluster facts into themes, optionally reusing existing themes.
   *
   * Implementations set `theme_id` on each passed fact to its final theme
   * (the schema's "assigned during clustering" contract) — persist the facts
   * after clustering to store the back-pointer. The returned array is the
   * complete theme set; a previously persisted theme absent from it (merged
   * away) should be deleted by the caller.
   */
  cluster(facts: SemanticFact[], existingThemes?: Theme[]): Promise<Theme[]>;
}

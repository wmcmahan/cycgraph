/**
 * The pr-review agents, each in its own file: the reviewer, its toolless
 * diff-only fallback, and the lesson distiller the reflection tail uses.
 *
 * @module maintenance/pr-review/agents
 */

import { reviewerAgent } from './reviewer.js';
import { reviewerFallbackAgent } from './reviewer-fallback.js';
import { distillerAgent } from './distiller.js';

export { reviewerAgent, reviewerFallbackAgent, distillerAgent };

/** The three agents one pr-review run builds. */
export type ReviewAgents = {
  reviewer: ReturnType<typeof reviewerAgent>;
  reviewerFallback: ReturnType<typeof reviewerFallbackAgent>;
  distiller: ReturnType<typeof distillerAgent>;
};

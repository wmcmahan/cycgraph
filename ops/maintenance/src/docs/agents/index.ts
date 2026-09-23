/**
 * The docs agents: the fixer and the lesson distiller the reflection tail
 * uses.
 *
 * @module maintenance/docs/agents
 */

import { fixerAgent } from './fixer.js';
import { distillerAgent } from './distiller.js';

export { fixerAgent, distillerAgent };

/** The two agents one docs-maintenance run builds. */
export type DocsAgents = {
  fixer: ReturnType<typeof fixerAgent>;
  distiller: ReturnType<typeof distillerAgent>;
};

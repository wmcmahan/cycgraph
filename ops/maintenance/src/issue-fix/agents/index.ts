/**
 * The issue-fix agents, each in its own file: the fixer and its advisory
 * toolless reviewer.
 *
 * @module maintenance/issue-fix/agents
 */

import { fixerAgent } from './fixer.js';
import { reviewerAgent } from './reviewer.js';

export { fixerAgent, reviewerAgent };

/** The two agents one issue-fix run builds. */
export type IssueFixAgents = {
  fixer: ReturnType<typeof fixerAgent>;
  reviewer: ReturnType<typeof reviewerAgent>;
};

/**
 * The implement-ticket agents: the implementer and its advisory toolless
 * reviewer.
 *
 * @module maintenance/implement-ticket/agents
 */

import { implementerAgent } from './implementer.js';
import { reviewerAgent } from './reviewer.js';

export { implementerAgent, reviewerAgent };

/** The two agents one implement-ticket run builds. */
export type ImplementAgents = {
  implementer: ReturnType<typeof implementerAgent>;
  reviewer: ReturnType<typeof reviewerAgent>;
};

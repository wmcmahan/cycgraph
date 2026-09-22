/**
 * The feature-propose agents: the surveyor (holds the tools) and the
 * toolless drafter, split so an empty proposal is structurally impossible.
 *
 * @module maintenance/feature-propose/agents
 */

import { surveyorAgent } from './surveyor.js';
import { drafterAgent } from './drafter.js';

export { surveyorAgent, drafterAgent };

/** The two agents one feature-propose run builds. */
export type FeatProposeAgents = {
  surveyor: ReturnType<typeof surveyorAgent>;
  drafter: ReturnType<typeof drafterAgent>;
};

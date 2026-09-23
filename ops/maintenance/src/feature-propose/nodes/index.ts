/**
 * The feature-propose nodes, each in its own file, built in dependency
 * order. This barrel owns that ordering; {@link graph.ts} owns how they
 * connect.
 *
 * @module maintenance/feature-propose/nodes
 */

import type { FeatProposeTools } from '../tools/index.js';
import type { FeatProposeAgents } from '../agents/index.js';
import { cloneNode } from './clone.js';
import { surveyNode } from './survey.js';
import { proposeNode } from './propose.js';
import { shapeNode } from './shape.js';
import { gateNode } from './gate.js';
import { ticketNode } from './ticket.js';
import { reportNode } from './report.js';

/** Build every node the graph needs, wired to tools and agents. */
export function featProposeNodes(tools: FeatProposeTools, agents: FeatProposeAgents) {
  const clone = cloneNode(tools);
  const survey = surveyNode(agents.surveyor);
  const propose = proposeNode(agents.drafter);
  const shape = shapeNode(tools);
  const gate = gateNode(shape);
  const ticket = ticketNode(tools, shape);
  const report = reportNode();
  return { clone, survey, propose, shape, gate, ticket, report };
}

/** The nodes of one feature-propose run. */
export type FeatProposeNodes = ReturnType<typeof featProposeNodes>;

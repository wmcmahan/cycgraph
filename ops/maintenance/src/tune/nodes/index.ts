/**
 * The tune nodes, each in its own file, built in dependency order. This
 * barrel owns the ordering; {@link graph.ts} owns how they connect.
 *
 * @module maintenance/tune/nodes
 */

import type { TuneContext } from '../context.js';
import type { TuneTools } from '../tools/index.js';
import type { analystAgent } from '../agents/analyst.js';
import { senseNode } from './sense.js';
import { proposeNode } from './propose.js';
import { shapeNode } from './shape.js';
import { shapedNode } from './shaped.js';
import { trialNode } from './trial.js';
import { wonNode } from './won.js';
import { ticketNode } from './ticket.js';
import { reportNode } from './report.js';

/** Build every node the graph needs, wired to context, tools, and the analyst. */
export function tuneNodes(c: TuneContext, tools: TuneTools, analyst: ReturnType<typeof analystAgent>) {
  const sense = senseNode(tools);
  const propose = proposeNode(c, analyst, sense);
  const shape = shapeNode(tools);
  const shaped = shapedNode(shape);
  const trial = trialNode(tools, shape);
  const won = wonNode(trial);
  const ticket = ticketNode(tools, shape, trial);
  const report = reportNode();
  return { sense, propose, shape, shaped, trial, won, ticket, report };
}

/** The nodes of one tune run. */
export type TuneNodes = ReturnType<typeof tuneNodes>;

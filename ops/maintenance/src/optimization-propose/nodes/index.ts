/**
 * The optimization-propose nodes, each in its own file, built in
 * dependency order. This barrel owns that ordering; {@link graph.ts} owns
 * how they connect.
 *
 * @module maintenance/optimization-propose/nodes
 */

import type { OptProposeTools } from '../tools/index.js';
import type { optimizerAgent } from '../agents/optimizer.js';
import { cloneNode } from './clone.js';
import { benchBeforeNode } from './bench-before.js';
import { proposeNode } from './propose.js';
import { benchAfterNode } from './bench-after.js';
import { verdictNode } from './verdict.js';
import { checksNode } from './checks.js';
import { gateNode } from './gate.js';
import { ticketNode } from './ticket.js';
import { reportNode } from './report.js';

/** Build every node the graph needs, wired to tools and the optimizer. */
export function optProposeNodes(tools: OptProposeTools, optimizer: ReturnType<typeof optimizerAgent>) {
  const clone = cloneNode(tools);
  const benchBefore = benchBeforeNode(tools);
  const propose = proposeNode(optimizer, benchBefore);
  const benchAfter = benchAfterNode(tools);
  const verdict = verdictNode(tools, benchBefore, benchAfter);
  const checks = checksNode(tools);
  const gate = gateNode(verdict, checks);
  const ticket = ticketNode(tools, verdict);
  const report = reportNode();
  return { clone, benchBefore, propose, benchAfter, verdict, checks, gate, ticket, report };
}

/** The nodes of one optimization-propose run. */
export type OptProposeNodes = ReturnType<typeof optProposeNodes>;

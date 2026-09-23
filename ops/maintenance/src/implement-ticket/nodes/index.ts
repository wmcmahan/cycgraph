/**
 * The implement-ticket graph-owned nodes, each in its own file, built in
 * dependency order. This barrel owns that ordering; the delivery nodes
 * (clone/commit/publish) come from `deliveryNodes` in the composer, and
 * {@link graph.ts} wires everything.
 *
 * @module maintenance/implement-ticket/nodes
 */

import type { ImplementContext } from '../context.js';
import type { ImplementTools } from '../tools/index.js';
import type { ImplementAgents } from '../agents/index.js';
import { pickNode } from './pick.js';
import { implementNode } from './implement.js';
import { acceptNode } from './accept.js';
import { checksNode } from './checks.js';
import { gateNode } from './gate.js';
import { diffNode } from './diff.js';
import { reviewNode } from './review.js';
import { reviewCheckNode } from './review-check.js';
import { giveUpNode } from './give-up.js';
import { reportNode } from './report.js';

/** Build every graph-owned node, wired to context, tools, and agents. */
export function implementNodes(c: ImplementContext, tools: ImplementTools, agents: ImplementAgents) {
  const pick = pickNode(tools);
  const implement = implementNode(c, agents.implementer, pick);
  const accept = acceptNode(tools, pick);
  const checks = checksNode(tools);
  const gate = gateNode(accept, checks);
  const diff = diffNode(tools);
  const review = reviewNode(agents.reviewer, pick, diff);
  const reviewCheck = reviewCheckNode(tools);
  const giveUp = giveUpNode(tools, pick);
  const report = reportNode();
  return { pick, implement, accept, checks, gate, diff, review, reviewCheck, giveUp, report };
}

/** The graph-owned nodes of one implement-ticket run (delivery excluded). */
export type ImplementNodes = ReturnType<typeof implementNodes>;

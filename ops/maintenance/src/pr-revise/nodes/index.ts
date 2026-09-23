/**
 * The pr-revise nodes, each in its own file, built in dependency order.
 *
 * `revise` and `deliver` read `gather`'s result, and `gate` reads
 * `checks`'s, so the upstream node objects are threaded into the ones
 * that reference them. This barrel owns that ordering; {@link graph.ts}
 * owns how they connect.
 *
 * @module maintenance/pr-revise/nodes
 */

import type { ReviseContext } from '../context.js';
import type { ReviseTools } from '../tools/index.js';
import type { reviserAgent } from '../agents/reviser.js';
import { gatherNode } from './gather.js';
import { reviseNode } from './revise.js';
import { checksNode } from './checks.js';
import { gateNode } from './gate.js';
import { deliverNode } from './deliver.js';
import { reportNode } from './report.js';

/** Build every node the graph needs, wired to context, tools, and the reviser. */
export function reviseNodes(c: ReviseContext, tools: ReviseTools, reviser: ReturnType<typeof reviserAgent>) {
  const gather = gatherNode(tools);
  const revise = reviseNode(c, reviser, gather);
  const checks = checksNode(tools);
  const gate = gateNode(checks);
  const deliver = deliverNode(tools, gather);
  const report = reportNode();
  return { gather, revise, checks, gate, deliver, report };
}

/** The six nodes of one pr-revise run. */
export type ReviseNodes = ReturnType<typeof reviseNodes>;

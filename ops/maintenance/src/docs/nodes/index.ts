/**
 * The docs-maintenance graph-owned nodes, each in its own file, built in
 * dependency order. `reflect` is present only with memory. This barrel owns
 * the ordering; the delivery nodes (clone/commit/publish) come from
 * `deliveryNodes` in the composer, and {@link graph.ts} wires everything.
 *
 * @module maintenance/docs/nodes
 */

import type { DocsContext } from '../context.js';
import type { DocsTools } from '../tools/index.js';
import type { DocsAgents } from '../agents/index.js';
import { scanNode } from './scan.js';
import { fixNode } from './fix.js';
import { judgeNode } from './judge.js';
import { checksNode } from './checks.js';
import { gateNode } from './gate.js';
import { reflectNode } from './reflect.js';
import { reportNode } from './report.js';

/** Build every graph-owned node, wired to context, tools, and agents. */
export function docsNodes(c: DocsContext, tools: DocsTools, agents: DocsAgents) {
  const scan = scanNode(tools);
  const fix = fixNode(c, agents.fixer, scan);
  const judge = judgeNode(tools, scan);
  const checks = checksNode(tools);
  const gate = gateNode(judge, checks);
  const reflect = reflectNode(c, agents.distiller);
  const report = reportNode();
  return { scan, fix, judge, checks, gate, reflect, report };
}

/** The graph-owned nodes of one docs run (`reflect` present only with memory). */
export type DocsNodes = ReturnType<typeof docsNodes>;

/**
 * The repo-audit nodes, each in its own file, built in dependency order.
 * The `audit` map node fans out `worker`; `reflect` is present only with
 * memory. This barrel owns the ordering; {@link graph.ts} owns how they
 * connect.
 *
 * @module maintenance/repo-audit/nodes
 */

import type { RepoAuditContext } from '../context.js';
import type { RepoAuditTools } from '../tools/index.js';
import type { RepoAuditAgents } from '../agents/index.js';
import { cloneNode } from './clone.js';
import { workerNode } from './worker.js';
import { auditNode } from './audit.js';
import { siftNode } from './sift.js';
import { reflectNode } from './reflect.js';
import { gateNode } from './gate.js';
import { ticketNode } from './ticket.js';
import { reportNode } from './report.js';

/** Build every node the graph needs, wired to context, tools, and agents. */
export function repoAuditNodes(c: RepoAuditContext, tools: RepoAuditTools, agents: RepoAuditAgents) {
  const clone = cloneNode(tools);
  const worker = workerNode(c, agents.auditor, clone);
  const audit = auditNode(c, clone);
  const sift = siftNode(tools, audit);
  const reflect = reflectNode(c, agents.distiller, sift);
  const gate = gateNode(sift);
  const ticket = ticketNode(tools, sift);
  const report = reportNode();
  return { clone, worker, audit, sift, reflect, gate, ticket, report };
}

/** The nodes of one repo-audit run (`reflect` present only with memory). */
export type RepoAuditNodes = ReturnType<typeof repoAuditNodes>;

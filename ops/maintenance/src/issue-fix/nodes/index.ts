/**
 * The issue-fix nodes, each in its own file, built in dependency order.
 *
 * Downstream nodes read upstream results, so the upstream node objects are
 * threaded into the ones that reference them. This barrel owns that
 * ordering; the delivery nodes (clone/commit/publish) come from
 * `deliveryNodes` in the composer, and {@link graph.ts} wires everything.
 *
 * @module maintenance/issue-fix/nodes
 */

import type { IssueFixContext } from '../context.js';
import type { IssueFixTools } from '../tools/index.js';
import type { IssueFixAgents } from '../agents/index.js';
import { pickNode } from './pick.js';
import { baselineNode } from './baseline.js';
import { fixNode } from './fix.js';
import { judgeNode } from './judge.js';
import { checksNode } from './checks.js';
import { gateNode } from './gate.js';
import { diffNode } from './diff.js';
import { reviewNode } from './review.js';
import { reviewCheckNode } from './review-check.js';
import { giveUpNode } from './give-up.js';
import { reportNode } from './report.js';

/** Build every graph-owned node, wired to context, tools, and agents. */
export function issueFixNodes(c: IssueFixContext, tools: IssueFixTools, agents: IssueFixAgents) {
  const pick = pickNode(tools);
  const baseline = baselineNode(tools, pick);
  const fix = fixNode(c, agents.fixer, baseline);
  const judge = judgeNode(tools, pick, baseline);
  const checks = checksNode(tools);
  const gate = gateNode(judge, checks);
  const diff = diffNode(tools);
  const review = reviewNode(agents.reviewer, baseline, diff);
  const reviewCheck = reviewCheckNode(tools);
  const giveUp = giveUpNode(tools, pick, baseline);
  const report = reportNode();
  return { pick, baseline, fix, judge, checks, gate, diff, review, reviewCheck, giveUp, report };
}

/** The graph-owned nodes of one issue-fix run (delivery nodes excluded). */
export type IssueFixNodes = ReturnType<typeof issueFixNodes>;

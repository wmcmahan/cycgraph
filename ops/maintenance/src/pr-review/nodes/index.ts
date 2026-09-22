/**
 * The pr-review nodes, each in its own file, built in dependency order.
 *
 * `review`/`review_fallback` read `gather`'s result, and `deliver` reads
 * `gather`'s and `verdict`'s, so the upstream node objects are threaded
 * into the ones that reference them. `reflect` is present only when memory
 * is on. This barrel owns that ordering; {@link graph.ts} owns how they
 * connect.
 *
 * @module maintenance/pr-review/nodes
 */

import type { ReviewContext } from '../context.js';
import type { ReviewTools } from '../tools/index.js';
import type { ReviewAgents } from '../agents/index.js';
import { gatherNode } from './gather.js';
import { reviewNode } from './review.js';
import { reviewFallbackNode } from './review-fallback.js';
import { verdictNode } from './verdict.js';
import { deliverNode } from './deliver.js';
import { reflectNode } from './reflect.js';
import { reportNode } from './report.js';

/** Build every node the graph needs, wired to context, tools, and agents. */
export function reviewNodes(c: ReviewContext, tools: ReviewTools, agents: ReviewAgents) {
  const gather = gatherNode(tools);
  const review = reviewNode(c, agents.reviewer, gather);
  const reviewFallback = reviewFallbackNode(agents.reviewerFallback, gather);
  const verdict = verdictNode(tools);
  const deliver = deliverNode(tools, verdict, gather);
  const reflect = reflectNode(c, agents.distiller);
  const report = reportNode();
  return { gather, review, reviewFallback, verdict, deliver, reflect, report };
}

/** The nodes of one pr-review run (`reflect` present only with memory). */
export type ReviewNodes = ReturnType<typeof reviewNodes>;

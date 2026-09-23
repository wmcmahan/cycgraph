/**
 * pr-review — a first-pass code review on a pull request.
 *
 * The maintenance loop delivers PRs; this workflow reads one the way a
 * colleague would before the human does: the full branch diff beside the
 * surrounding code, plus the change's stated intent — the PR description
 * and, through its `Closes #N` lines, every issue it claims to resolve,
 * delimited as data because issue text is attacker-reachable — so a clean
 * implementation of the wrong fix is reviewable as such. The reviewer has
 * read-only hands (search and read_file over a checkout of the PR branch),
 * so it can verify what a diff-only reviewer must take on faith. Its
 * verdict is submitted as a real pull-request review: findings anchor
 * inline on the diff, and an APPROVE approves the PR — degraded to a
 * comment-state review where GitHub forbids the token reviewing its own
 * PR. A verification pass resolves the threads of prior findings it marks
 * ADDRESSED — only threads this workflow itself opened. Nothing is ever
 * pushed. By default the human merge stays the gate; with `merge` on, an
 * APPROVE against a managed PR arms auto-merge instead, and the human gate
 * becomes the ability to stop it.
 *
 * pr-revise is the counterpart: on a REVISE verdict against a PR that
 * carries the maintenance-managed label, the review body ends with the
 * @cycgraph trigger pr-revise listens for, so the finding is addressed
 * without a human relaying it. The label is the consent: GitHub restricts
 * labeling to triage+ users, bot PRs are labeled at creation, and an
 * unlabeled PR gets findings only. A push to a labeled PR re-runs the
 * review as a verification pass over the prior findings, and the cycle is
 * bounded by a rounds cap — after the third review the findings post
 * without a handoff and the PR waits for the human under the needs-human
 * label, exactly like every other waiting-on-human state; a later
 * approving review clears it. The human can always take over sooner.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the agents, the nodes, and the graph, each from its
 * own file.
 *
 * @module maintenance/pr-review
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { buildReviewContext, params } from './context.js';
import type { Params } from './context.js';
import { reviewTools } from './tools/index.js';
import { reviewerAgent, reviewerFallbackAgent, distillerAgent } from './agents/index.js';
import { reviewNodes } from './nodes/index.js';
import { reviewGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The pr-review workflow. */
export function prReview(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'pr-review',
    title: 'Review a pull request against the code around it',
    covers: ['maintenance', 'review'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const context = await buildReviewContext(p, env);
      const tools = reviewTools(context);
      const agents = {
        reviewer: reviewerAgent(context, tools),
        reviewerFallback: reviewerFallbackAgent(context),
        distiller: distillerAgent(context),
      };
      const nodes = reviewNodes(context, tools, agents);
      return reviewGraph(context, nodes);
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'gather_result' },
    ],
  };
}

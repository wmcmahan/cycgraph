/**
 * The reviser's hands and the run's four tool-node primitives.
 *
 * `hands` are the workspace editing surface the agent drives directly;
 * the four tool nodes bracket it — `gather` reads the feedback and checks
 * out the branch, `runCheck` verifies mid-edit, `checks` is the gate's
 * read-only pass, and `deliver` commits, pushes, and replies. Each is its
 * own file; this barrel binds them all to one {@link ReviseContext}.
 *
 * @module maintenance/pr-revise/tools
 */

import type { ReviseContext } from '../context.js';
import { reviseHands } from './hands.js';
import { runCheckTool } from './run-check.js';
import { gatherFeedbackTool } from './gather-feedback.js';
import { repoChecksTool } from './repo-checks.js';
import { pushRevisionTool } from './push-revision.js';

/** Build every tool the run needs, bound to the given context. */
export function reviseTools(c: ReviseContext) {
  return {
    hands: reviseHands(c),
    runCheck: runCheckTool(c),
    gather: gatherFeedbackTool(c),
    checks: repoChecksTool(c),
    deliver: pushRevisionTool(c),
  };
}

/** The reviser's hands and the run's tool-node primitives. */
export type ReviseTools = ReturnType<typeof reviseTools>;

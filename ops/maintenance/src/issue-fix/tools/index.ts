/**
 * The fixer's hands and the run's tool-node primitives.
 *
 * `hands` are the editing surface the fixer drives directly, `probe` is the
 * fast `workspace_check` it also holds; the rest are tool nodes — `pick`
 * chooses the issue, `baseline` relocates the finding, `judgeFix` judges
 * the fix, `checks` is the gate's run, `diff` feeds the reviewer, `giveUp`
 * flags a dead end, and `reviewCheck` parses the reviewer's verdict. Each
 * is its own file; this barrel binds them all to one {@link IssueFixContext}.
 *
 * @module maintenance/issue-fix/tools
 */

import type { IssueFixContext } from '../context.js';
import { issueFixHands } from './hands.js';
import { pickTool } from './pick.js';
import { baselineTool } from './baseline.js';
import { judgeFixTool } from './judge-fix.js';
import { checkTools } from './checks.js';
import { diffTool } from './diff.js';
import { giveUpTool } from './give-up.js';
import { reviewCheckTool } from './review-check.js';

/** Build every tool the run needs, bound to the given context. */
export function issueFixTools(c: IssueFixContext) {
  const { checks, probe } = checkTools(c);
  return {
    hands: issueFixHands(c),
    probe,
    pick: pickTool(c),
    baseline: baselineTool(c),
    judgeFix: judgeFixTool(c),
    checks,
    diff: diffTool(c),
    giveUp: giveUpTool(c),
    reviewCheck: reviewCheckTool(),
  };
}

/** The fixer's hands and the run's tool-node primitives. */
export type IssueFixTools = ReturnType<typeof issueFixTools>;

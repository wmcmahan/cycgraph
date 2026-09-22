/**
 * The implementer's hands and the run's tool-node primitives.
 *
 * `hands` are the editing surface, `runCheck` the implementer's mid-edit
 * check (wired only when local checks are on); the tool nodes are `pick`,
 * `accept`, `checks`, `diff`, `reviewCheck`, and `giveUp`. Each is its own
 * file; this barrel binds them all to one {@link ImplementContext}.
 *
 * @module maintenance/implement-ticket/tools
 */

import type { ImplementContext } from '../context.js';
import { implementHands } from './hands.js';
import { runCheckTool } from './run-check.js';
import { pickTool } from './pick.js';
import { acceptTool } from './accept.js';
import { checksTool } from './checks.js';
import { diffTool } from './diff.js';
import { reviewCheckTool } from './review-check.js';
import { giveUpTool } from './give-up.js';

/** Build every tool the run needs, bound to the given context. */
export function implementTools(c: ImplementContext) {
  return {
    hands: implementHands(c),
    runCheck: runCheckTool(c),
    pick: pickTool(c),
    accept: acceptTool(c),
    checks: checksTool(c),
    diff: diffTool(c),
    reviewCheck: reviewCheckTool(),
    giveUp: giveUpTool(c),
  };
}

/** The implementer's hands and the run's tool-node primitives. */
export type ImplementTools = ReturnType<typeof implementTools>;

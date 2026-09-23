/**
 * The analyst's read-only hands: search and read over the real repository.
 *
 * Unlike the other workflows, tune's hands are rooted at the repository
 * itself, not a clone — the analyst studies the live workflow source to
 * quote the exact instruction text to edit. The trial tool does the
 * cloning.
 *
 * @module maintenance/tune/tools/hands
 */

import { readFileTool, searchTool } from '@cycgraph/tools/workspace';
import type { TuneContext } from '../context.js';

/** The two read-only workspace tools, rooted at the repository. */
export function tuneHands(c: TuneContext) {
  const { repoRoot, session } = c;
  return {
    read: readFileTool({ root: repoRoot, session }),
    search: searchTool({ root: repoRoot }),
  };
}

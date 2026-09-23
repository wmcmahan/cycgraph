/**
 * The reviewer's read-only hands: search and read.
 *
 * These are the workspace tools the reviewer drives directly to verify
 * what a diff alone cannot show — whether a helper already exists, whether
 * an edit matches the conventions around it. Read-only: the review never
 * pushes, so there is no edit or create hand.
 *
 * @module maintenance/pr-review/tools/hands
 */

import { readFileTool, searchTool } from '@cycgraph/tools/workspace';
import type { ReviewContext } from '../context.js';

/** The two read-only workspace tools, bound to the clone. */
export function reviewHands(c: ReviewContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
  };
}

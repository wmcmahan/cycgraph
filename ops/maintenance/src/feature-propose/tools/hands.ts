/**
 * The surveyor's read-only hands: search and read.
 *
 * The proposer's hands are read-only — nothing is edited — so the surveyor
 * grounds its notes in the tree it reads.
 *
 * @module maintenance/feature-propose/tools/hands
 */

import { readFileTool, searchTool } from '@cycgraph/tools/workspace';
import type { FeatProposeContext } from '../context.js';

/** The two read-only workspace tools, bound to the clone. */
export function featProposeHands(c: FeatProposeContext) {
  const { workspaceAt, session } = c;
  return {
    read: readFileTool({ root: workspaceAt, session }),
    search: searchTool({ root: workspaceAt }),
  };
}

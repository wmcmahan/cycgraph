/**
 * diff — the implementation diff, for the reviewer.
 *
 * @module maintenance/implement-ticket/nodes/diff
 */

import { node } from '@cycgraph/orchestrator';
import type { ImplementTools } from '../tools/index.js';

/** The workspace_diff tool node. */
export function diffNode(tools: ImplementTools) {
  return node({ id: 'diff', type: 'tool', toolId: 'workspace_diff', tools: [tools.diff], reads: [] });
}

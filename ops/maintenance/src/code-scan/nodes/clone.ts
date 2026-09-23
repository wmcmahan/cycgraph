/**
 * clone — the run's entry node: set up the disposable workspace.
 *
 * @module maintenance/code-scan/nodes/clone
 */

import { node } from '@cycgraph/orchestrator';
import type { CodeScanTools } from '../tools/index.js';

/** The clone_repo tool node. */
export function cloneNode(tools: CodeScanTools) {
  return node({
    id: 'clone',
    type: 'tool',
    toolId: 'clone_repo',
    tools: [tools.clone],
    reads: []
  });
}

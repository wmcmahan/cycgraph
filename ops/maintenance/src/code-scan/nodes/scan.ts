/**
 * scan — sense the codebase's owed upkeep.
 *
 * @module maintenance/code-scan/nodes/scan
 */

import { node } from '@cycgraph/orchestrator';
import type { CodeScanTools } from '../tools/index.js';

/** The scan_core tool node. */
export function scanNode(tools: CodeScanTools) {
  return node({
    id: 'scan',
    type: 'tool',
    toolId: 'scan_core',
    tools: [tools.scan],
    reads: []
  });
}
/**
 * scan — find the next stale documentation claim to fix.
 *
 * @module maintenance/docs/nodes/scan
 */

import { node } from '@cycgraph/orchestrator';
import type { DocsTools } from '../tools/index.js';

/** The scan_docs tool node, reading the last commit and judge results. */
export function scanNode(tools: DocsTools) {
  return node({ id: 'scan', type: 'tool', toolId: 'scan_docs', tools: [tools.scan], reads: ['commit_result', 'judge_result'] });
}

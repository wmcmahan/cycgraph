/**
 * triage — dedupe the findings and file the new ones.
 *
 * @module maintenance/code-scan/nodes/triage
 */

import { node } from '@cycgraph/orchestrator';
import type { CodeScanTools } from '../tools/index.js';
import type { scanNode } from './scan.js';

/** The triage_findings tool node, reading the scan result. */
export function triageNode(tools: CodeScanTools, scan: ReturnType<typeof scanNode>) {
  return node({
    id: 'triage',
    type: 'tool',
    toolId: 'triage_findings',
    tools: [tools.triage],
    reads: [scan.result]
  });
}

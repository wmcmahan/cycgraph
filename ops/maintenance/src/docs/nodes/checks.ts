/**
 * checks — the gate's check run over the fix.
 *
 * @module maintenance/docs/nodes/checks
 */

import { node } from '@cycgraph/orchestrator';
import type { DocsTools } from '../tools/index.js';

/** The repo_checks tool node. */
export function checksNode(tools: DocsTools) {
  return node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [tools.checks], reads: [] });
}

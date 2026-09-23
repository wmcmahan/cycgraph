/**
 * checks — the gate's check run beyond acceptance.
 *
 * @module maintenance/implement-ticket/nodes/checks
 */

import { node } from '@cycgraph/orchestrator';
import type { ImplementTools } from '../tools/index.js';

/** The repo_checks tool node. */
export function checksNode(tools: ImplementTools) {
  return node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [tools.checks], reads: [] });
}

/**
 * clone — the run's entry node: clone, map, and cut the charter list.
 *
 * @module maintenance/repo-audit/nodes/clone
 */

import { node } from '@cycgraph/orchestrator';
import type { RepoAuditTools } from '../tools/index.js';

/** The clone_repo tool node. */
export function cloneNode(tools: RepoAuditTools) {
  return node({ id: 'clone', type: 'tool', toolId: 'clone_repo', tools: [tools.clone] });
}

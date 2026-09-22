/**
 * repo-audit — model-driven discovery, the semantic front end the
 * mechanical scanners cannot be.
 *
 * The docs and code scanners find what a detector can name: a dead link, a
 * missing path, an unknown script. This workflow fans out read-only
 * auditors, each holding one charter — a lens (correctness, docs-truth,
 * security, test-gaps) applied to one scope of the repository — and asks
 * them to find what only judgement can: a claim the source contradicts, a
 * silent failure path, a permission gap, load-bearing behavior no test
 * pins. Reports come back in a structured finding format, are sifted
 * mechanically (evidence must name real paths, duplicates and already-filed
 * findings drop, severity ranks the rest), and the shortlist is filed as
 * marker-keyed tickets. Approval, the fix, and the PR ride the same ladder
 * as every other issue; the merge is the finding's honest fitness signal.
 *
 * Nothing is edited: every auditor's hands are search and read only. The
 * charter cross-product is ordered diagonally so a low `maxAuditors` cap
 * still spreads across both lenses and scopes, and `skip` rotates a later
 * run onto the next slice.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the agents, the nodes, and the graph, each from its
 * own file.
 *
 * @module maintenance/repo-audit
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { buildRepoAuditContext, params } from './context.js';
import type { Params } from './context.js';
import { repoAuditTools } from './tools/index.js';
import { auditorAgent, distillerAgent } from './agents/index.js';
import { repoAuditNodes } from './nodes/index.js';
import { repoAuditGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

// Re-exported for the package barrel and the workflow tests.
export { charterOrder, changedScopesSince } from './charter.js';

/** The repo-audit workflow. */
export function repoAudit(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'repo-audit',
    title: 'Fan out auditors over the repository; verified findings become tickets',
    covers: ['maintenance', 'audit', 'discovery'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const context = await buildRepoAuditContext(p, env);
      const tools = repoAuditTools(context);
      const agents = { auditor: auditorAgent(context, tools), distiller: distillerAgent(context) };
      const nodes = repoAuditNodes(context, tools, agents);
      return repoAuditGraph(context, nodes);
    },

    // The objective signal is the gate boolean: the fan-out reported and
    // the sift could judge. Kept-count is deliberately not asserted — a
    // clean audit is a success, and asserting findings exist would teach
    // the tune loop to reward invention.
    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'sift_result' },
      { type: 'memory_matches', key: 'gate_verification_passed', mode: 'exact', expected: true, pattern: '' },
    ],
  };
}

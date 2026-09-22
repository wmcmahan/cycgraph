/**
 * code-scan — files what the codebase owes itself as GitHub issues.
 *
 * The upkeep tier's sense half. Every detector is mechanical
 * ({@link ./scan.js}), and the issues it files are the proposal ledger
 * externalized: a finding becomes one issue carrying a stable marker,
 * dedupe against open issues means nothing is filed twice, and a cap bounds
 * each run. Filing is refused entirely when the ledger cannot be read,
 * because filing blind is how duplicates happen.
 *
 * No model is involved and nothing is edited: the fix cycle over approved
 * issues is a later tier. Purely mechanical also means purely verifiable —
 * the eval asserts the triage happened, and the triage result says exactly
 * what was filed and why.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the nodes, and the graph, each from its own file.
 *
 * @module maintenance/code-scan
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { buildCodeScanContext, params } from './context.js';
import type { Params } from './context.js';
import { codeScanTools } from './tools/index.js';
import { codeScanNodes } from './nodes/index.js';
import { codeScanGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The code-scan workflow. */
export function coreUpkeep(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'code-scan',
    title: 'Scan the code for mechanical upkeep (TODOs, skipped tests, lint) and file it as issues',
    covers: ['maintenance', 'upkeep', 'issues'],
    requires: [],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const context = await buildCodeScanContext(p, env);
      const tools = codeScanTools(context);
      const nodes = codeScanNodes(tools);
      return codeScanGraph(nodes);
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'triage_result' },
    ],
  };
}

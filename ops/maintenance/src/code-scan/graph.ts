/**
 * The code-scan topology: clone → scan → triage → report. Linear and
 * mechanical — no model, no loop.
 *
 * The nodes come pre-built from {@link nodes/index.ts}; this file owns only
 * how they connect and the run's start state.
 *
 * @module maintenance/code-scan/graph
 */

import { graph } from '@cycgraph/orchestrator';
import type { CodeScanNodes } from './nodes/index.js';

/** The graph, its start state, and runner options for one code-scan run. */
export function codeScanGraph(nodes: CodeScanNodes) {
  const { clone, scan, triage, report } = nodes;
  return {
    graph: graph({
      name: 'code-scan',
      description: 'Sense owed upkeep mechanically and file it as deduped, capped issues.',
      nodes: [clone, scan, triage, report],
      edges: [
        { from: clone, to: scan },
        { from: scan, to: triage },
        { from: triage, to: report },
      ],
      startNode: clone,
      endNodes: [report],
    }),
    input: { goal: 'File the codebase\'s owed upkeep as issues.' },
    runner: {},
  };
}

/**
 * The code-scan nodes, each in its own file, built in dependency order.
 * This barrel owns that ordering; {@link graph.ts} owns how they connect.
 *
 * @module maintenance/code-scan/nodes
 */

import type { CodeScanTools } from '../tools/index.js';
import { cloneNode } from './clone.js';
import { scanNode } from './scan.js';
import { triageNode } from './triage.js';
import { reportNode } from './report.js';

/** Build every node the graph needs, wired to the tools. */
export function codeScanNodes(tools: CodeScanTools) {
  const clone = cloneNode(tools);
  const scan = scanNode(tools);
  const triage = triageNode(tools, scan);
  const report = reportNode();
  return { clone, scan, triage, report };
}

/** The nodes of one code-scan run. */
export type CodeScanNodes = ReturnType<typeof codeScanNodes>;

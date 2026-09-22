/**
 * scan_core — sense the codebase's mechanically-detectable owed upkeep.
 *
 * Wraps the pure {@link ../scan.js} sensing and summarizes the findings by
 * kind for the triage step.
 *
 * @module maintenance/code-scan/tools/scan
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { scanCore } from '../scan.js';
import type { CodeScanContext } from '../context.js';

/** The scan_core tool, bound to the clone. */
export function scanTool(c: CodeScanContext) {
  const { workspaceAt, params: p } = c;
  return tool({
    name: 'scan_core',
    description: 'Sense the codebase\'s mechanically-detectable owed upkeep.',
    parameters: z.object({}),
    timeoutMs: 300_000,
    execute: async () => {
      const findings = await scanCore(workspaceAt, { lint: p.lint });
      const byKind: Record<string, number> = {};
      for (const finding of findings) byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
      return {
        total: findings.length,
        by_kind: byKind,
        findings: findings.slice(0, 50),
      };
    },
  });
}

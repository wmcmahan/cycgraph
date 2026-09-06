/**
 * core-upkeep — files what the codebase owes itself as GitHub issues.
 *
 * The upkeep tier's sense half. Every detector is mechanical
 * (`core-scan.ts`), and the issues it files are the proposal ledger
 * externalized: a finding becomes one issue carrying a stable marker,
 * dedupe against open issues means nothing is filed twice, and a cap
 * bounds each run. Filing is refused entirely when the ledger cannot
 * be read, because filing blind is how duplicates happen.
 *
 * No model is involved and nothing is edited: the fix cycle over
 * approved issues is a later tier. Purely mechanical also means purely
 * verifiable — the eval asserts the triage happened, and the triage
 * result says exactly what was filed and why.
 *
 * @module maintenance/core-workflow
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { graph, node, tool } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import {
  cloneToBranch,
  createIssue,
  findingMarker,
  issueMarkers,
  listOpenIssues,
} from '@cycgraph/tools/git';
import { scanCore, unfiledFindings, type CoreFinding } from './core-scan.js';
import { resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose upkeep is sensed. Empty means the repository this runs inside'),
  maxIssues: z.number().int().min(1).max(10).default(3)
    .describe('New issues to file in one run'),
  lint: z.boolean().default(true)
    .describe('Include the eslint sense class. Off keeps a run to the cheap grep classes'),
  file: z.boolean().default(true)
    .describe('File the issues. Off reports what would be filed and touches nothing'),
});

type Params = z.infer<typeof params>;

function issueFor(finding: CoreFinding): { title: string; body: string } {
  return {
    title: `[maintenance] ${finding.kind} in ${finding.file}`,
    body: [
      finding.detail,
      '',
      `Location: \`${finding.file}:${finding.line}\``,
      '',
      'Filed by the core-upkeep workflow from a mechanical scan of the repository.',
      '',
      findingMarker(finding.key),
    ].join('\n'),
  };
}

/** The core-upkeep workflow. */
export function coreUpkeep(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'core-upkeep',
    title: 'File the codebase\'s owed upkeep as issues',
    covers: ['maintenance', 'upkeep', 'issues'],
    requires: [],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const workspaceAt = join(tmpdir(), `cycgraph-upkeep-${randomUUID()}`);
      const token = env.publish?.token;

      const cloneTool = tool({
        name: 'clone_repo',
        description: 'Clone the repository into a disposable workspace.',
        parameters: z.object({}),
        execute: async () => {
          const ws = await cloneToBranch(repoRoot, `upkeep/scan-${randomUUID().slice(0, 8)}`, { at: workspaceAt });
          return { workspace: ws.root };
        },
      });

      const scanTool = tool({
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

      const triageTool = tool({
        name: 'triage_findings',
        description: 'Dedupe findings against open issues and file the new ones, capped.',
        parameters: z.object({ scan_result: z.unknown().optional() }),
        timeoutMs: 120_000,
        execute: async ({ scan_result }) => {
          const scan = scan_result as { findings?: CoreFinding[] } | undefined;
          const findings = scan?.findings ?? [];
          const issues = await listOpenIssues(repoRoot, token !== undefined ? { token } : {});

          if (issues === undefined) {
            return {
              ledger_visible: false,
              filed: [],
              detail: p.file
                ? 'cannot read the issue ledger (gh missing, unauthenticated, or no remote) — refusing to file blind'
                : 'cannot read the issue ledger — candidates below are not deduped',
              ...(p.file ? {} : { would_file: findings.slice(0, p.maxIssues).map((f) => f.key) }),
            };
          }

          const fresh = unfiledFindings(findings, issueMarkers(issues));
          const toFile = fresh.slice(0, p.maxIssues);
          const base = {
            ledger_visible: true,
            new_count: fresh.length,
            skipped_existing: findings.length - fresh.length,
          };
          if (!p.file) {
            return { ...base, filed: [], would_file: toFile.map((f) => f.key), detail: 'dry run' };
          }

          const filed: { key: string; url: string }[] = [];
          const errors: string[] = [];
          for (const finding of toFile) {
            const outcome = await createIssue(repoRoot, issueFor(finding), token !== undefined ? { token } : {});
            if ('url' in outcome) filed.push({ key: finding.key, url: outcome.url });
            else errors.push(`${finding.key}: ${outcome.error}`);
          }
          return {
            ...base,
            filed,
            errors,
            detail: `filed ${filed.length} of ${toFile.length} new finding(s); ${fresh.length - filed.length} remain`,
          };
        },
      });

      const clone = node({ id: 'clone', type: 'tool', toolId: 'clone_repo', tools: [cloneTool] });
      const scan = node({ id: 'scan', type: 'tool', toolId: 'scan_core', tools: [scanTool], reads: [] });
      const triage = node({
        id: 'triage',
        type: 'tool',
        toolId: 'triage_findings',
        tools: [triageTool],
        reads: [scan.result],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'core-upkeep',
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
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'triage_result' },
    ],
  };
}

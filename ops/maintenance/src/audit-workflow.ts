/**
 * repo-audit — model-driven discovery, the semantic front end the
 * mechanical scanners cannot be.
 *
 * The docs and core scanners find what a detector can name: a dead link,
 * a missing path, an unknown script. This workflow fans out read-only
 * auditors, each holding one charter — a lens (correctness, docs-truth,
 * security, test-gaps) applied to one scope of the repository — and asks
 * them to find what only judgement can: a claim the source contradicts,
 * a silent failure path, a permission gap, load-bearing behavior no test
 * pins. Reports come back in a structured finding format, are sifted
 * mechanically (evidence must name real paths, duplicates and
 * already-filed findings drop, severity ranks the rest), and the
 * shortlist is filed as marker-keyed tickets. Approval
 * (`maintenance-approved`), the fix, and the PR ride the same ladder as
 * every other issue; the merge is the finding's honest fitness signal.
 *
 * Nothing is edited: every auditor's hands are search and read only.
 * The charter cross-product is ordered diagonally so a low `maxAuditors`
 * cap still spreads across both lenses and scopes, and `skip` rotates a
 * later run onto the next slice.
 *
 * @module maintenance/audit-workflow
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { agent, graph, mapReduce, node, reflection, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { cloneToBranch, createIssue, findingMarker, issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { createWorkspaceSession, readFileTool, searchTool } from '@cycgraph/tools/workspace';
import { auditKey, siftAuditFindings, type AuditFinding } from './audit-findings.js';
import { CANDIDATE_TAG, LESSON_TAG } from './memory.js';
import { repoMap, resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const LENS_BRIEFS: Record<string, string> = {
  correctness:
    'Hunt real defects: wrong fallbacks, silent failure paths, race conditions, schema or serialization mismatches, '
    + 'error handling that swallows what it should surface. A defect is only a finding when you can name the exact '
    + 'code path and the input or state that makes it misbehave.',
  'docs-truth':
    'Find claims the documentation makes that the source contradicts: described behavior that differs from the '
    + 'implementation, APIs documented with the wrong shape, features described that do not exist, and shipped '
    + 'behavior the docs omit entirely. Read the source first, then check what the docs say about it.',
  security:
    'Find gaps in the security posture: taint that fails to propagate, permission checks that can be bypassed, '
    + 'injection surfaces where external text reaches a prompt or command unsanitized, allowlists with holes, '
    + 'secrets that could reach an agent. Judge against the mandates in CLAUDE.md.',
  'test-gaps':
    'Find load-bearing behavior no test pins: exported functions whose edge cases are unasserted, invariants the '
    + 'code relies on that nothing would catch a regression in, and tests that assert vacuously. Name the behavior '
    + 'and the file that should test it.',
};

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository to audit. Empty means the repository this runs inside'),
  lenses: z.array(z.string()).default(Object.keys(LENS_BRIEFS))
    .describe('Audit lenses to apply. Names outside the built-in set are passed to auditors as literal charters'),
  scopes: z.array(z.string()).default([])
    .describe('Repository paths to audit, e.g. ["packages/orchestrator"]. Empty derives one scope per workspace package'),
  maxAuditors: z.number().int().min(1).max(32).default(12)
    .describe('Charters fanned out in one run; the lens × scope cross-product is capped to this'),
  skip: z.number().int().min(0).default(0)
    .describe('Charters to skip, so a later run rotates onto the next slice of the cross-product'),
  concurrency: z.number().int().min(1).max(8).default(4)
    .describe('Auditors in flight at once'),
  steps: z.number().int().min(8).max(50).default(48)
    .describe('Tool-call steps each auditor may spend before it must report'),
  maxFindings: z.number().int().min(1).max(20).default(5)
    .describe('Findings filed per run after ranking'),
  file: z.boolean().default(true)
    .describe('File the shortlist as issues. Off reports the sift verdict only'),
  focus: z.string().default('')
    .describe('Steer every charter toward an area or concern. Empty leaves charters as lens × scope'),
  prompt: z.string().default('')
    .describe('Override the auditor agent\'s instructions. A config knob so the tune loop can sweep it'),
  budgetTokens: z.number().int().min(0).default(6_000_000)
    .describe('Hard token budget for the run; zero removes the cap. The fan-out stops dispatching auditors as the budget nears, so a tight budget trims the charter list rather than failing the run. Sized from a measured full run: ~4.15M billed for 12 deep auditors with partial cache hits'),
});

type Params = z.infer<typeof params>;

/** One auditor's assignment, delivered via the map node's task context. */
interface AuditCharter {
  lens: string;
  scope: string;
  brief: string;
}

/** Workspace package directories, one audit scope each. */
async function deriveScopes(root: string): Promise<string[]> {
  const scopes: string[] = [];
  for (const parent of ['packages', 'ops', 'apps']) {
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json'))) {
        scopes.push(`${parent}/${entry.name}`);
      }
    }
  }
  return scopes;
}

/**
 * The lens × scope cross-product in diagonal order, so a cap keeps a
 * spread across both dimensions instead of exhausting one first.
 */
export function charterOrder(lenses: string[], scopes: string[]): Array<{ lens: string; scope: string }> {
  const pairs: Array<{ lens: string; scope: string; l: number; s: number }> = [];
  lenses.forEach((lens, l) => scopes.forEach((scope, s) => pairs.push({ lens, scope, l, s })));
  pairs.sort((a, b) => (a.l + a.s) - (b.l + b.s) || a.s - b.s || a.l - b.l);
  return pairs.map(({ lens, scope }) => ({ lens, scope }));
}

/** The repo-audit workflow. */
export function repoAudit(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'repo-audit',
    title: 'Fan out auditors over the repository; verified findings become tickets',
    covers: ['maintenance', 'audit', 'discovery'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-audit-${randomUUID()}`);
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
      };

      const cloneTool = tool({
        name: 'clone_repo',
        description: 'Clone the repository, map it, and cut the charter list for this run.',
        parameters: z.object({}),
        timeoutMs: 120_000,
        execute: async () => {
          const ws = await cloneToBranch(repoRoot, `audit/scan-${randomUUID().slice(0, 8)}`, { at: workspaceAt });
          const scopes = p.scopes.length > 0 ? p.scopes : await deriveScopes(ws.root);
          const charters: AuditCharter[] = charterOrder(p.lenses, scopes)
            .slice(p.skip, p.skip + p.maxAuditors)
            .map(({ lens, scope }) => ({
              lens,
              scope,
              brief: [
                LENS_BRIEFS[lens] ?? lens,
                `Your scope is ${scope}: read there, though evidence may cite any path that supports the finding.`,
                ...(p.focus !== '' ? [`Focus: ${p.focus}.`] : []),
              ].join(' '),
            }));
          return { workspace: ws.root, charter_count: charters.length, charters, map: await repoMap(ws.root) };
        },
      });

      const siftTool = tool({
        name: 'sift_findings',
        description: 'Parse, evidence-check, dedupe, and rank the auditors\' findings.',
        parameters: z.object({
          audit_results: z.unknown().optional(),
          audit_error_count: z.unknown().optional(),
        }),
        timeoutMs: 120_000,
        execute: async ({ audit_results, audit_error_count }) => {
          const entries = (Array.isArray(audit_results) ? audit_results : []) as
            Array<{ updates?: Record<string, unknown> }>;
          const reports = entries
            .map((entry) => entry.updates?.['audit_report'])
            .filter((report): report is string => typeof report === 'string' && report.trim() !== '');

          const issues = await listOpenIssues(repoRoot, token !== undefined ? { token } : {});
          const sifted = siftAuditFindings(reports, {
            pathExists: (path) => existsSync(join(workspaceAt, path)),
            ...(issues !== undefined ? { openKeys: issueMarkers(issues) } : {}),
            cap: p.maxFindings,
          });

          const errorCount = typeof audit_error_count === 'number' ? audit_error_count : 0;
          return {
            // Coherent means the fan-out produced something to judge: at
            // least one auditor reported, and the issue ledger was readable
            // when filing is on (filing blind would duplicate tickets).
            ok: reports.length > 0 && (issues !== undefined || !p.file),
            report_count: reports.length,
            worker_errors: errorCount,
            kept: sifted.kept,
            kept_count: sifted.kept.length,
            drops: sifted.drops,
            clean_reports: sifted.clean_reports,
          };
        },
      });

      const ticketTool = tool({
        name: 'file_tickets',
        description: 'File the shortlisted findings as marker-keyed, deduped issues.',
        parameters: z.object({ sift_result: z.unknown().optional() }),
        timeoutMs: 300_000,
        execute: async ({ sift_result }) => {
          const kept = ((sift_result as { kept?: AuditFinding[] } | undefined)?.kept) ?? [];
          if (!p.file) return { filed: 0, detail: 'dry run' };

          const urls: string[] = [];
          const failures: string[] = [];
          for (const finding of kept) {
            const outcome = await createIssue(repoRoot, {
              title: `[audit:${finding.severity}] ${finding.title}`,
              body: [
                `SEVERITY: ${finding.severity}`,
                '',
                'EVIDENCE:', finding.evidence, '',
                'DETAIL:', finding.detail,
                ...(finding.suggestion !== '' ? ['', 'SUGGESTION:', finding.suggestion] : []),
                '',
                'Found by the repo-audit workflow from a read-only sweep; evidence paths were verified to exist before filing.',
                'Approve with the `maintenance-approved` label; the fix and the PR follow the maintenance ladder, and the merge is the accept signal.',
                '',
                findingMarker(auditKey(finding.title)),
              ].join('\n'),
            }, token !== undefined ? { token } : {});
            if ('url' in outcome) urls.push(outcome.url);
            else failures.push(outcome.error);
          }
          return {
            filed: urls.length,
            urls,
            ...(failures.length > 0 ? { failures } : {}),
            detail: `filed ${urls.length} of ${kept.length}`,
          };
        },
      });

      const auditor = agent({
        id: 'repo-auditor',
        name: 'Repository auditor',
        model: env.model,
        provider: env.provider,
        temperature: 0.3,
        maxSteps: p.steps,
        instructions: p.prompt !== '' ? p.prompt : [
          'You audit a repository read-only under one charter. The charter — a lens and a scope — is in your Task Context; a map of the repository is in your context.',
          'Go deep, not wide: follow the charter into real source and chase a suspicion until you can prove or drop it. Never report a hunch you did not confirm with read_file.',
          'Read with intent: every read_file result rides the rest of your context, so each one must earn its place. read_file windows large files and reports the total line count — after a search hit, pull the exact slice with offset and limit instead of paging through the whole file, and never re-read a file or slice you already have; cite from what you read the first time. Reserve whole-file reads for small files and for the rare case where the charter genuinely needs the full picture.',
          'Report at most your three strongest findings. One proven finding beats five plausible ones: the sift drops anything whose evidence names no real path, and a human reviews every ticket.',
          'Reply with zero or more blocks in exactly this format, each header on its own line:',
          'FINDING: <one line naming the defect or gap>',
          'SEVERITY: high | medium | low',
          'EVIDENCE:', '<real repository paths, each with one line on what it shows>',
          'DETAIL:', '<what is wrong, why it matters, and the input or state that exposes it>',
          'SUGGESTION:', '<the shape of the fix, not the fix itself>',
          'Cite a path only after read_file has shown you its contents.',
          'When the charter turns up nothing you can prove, reply CLEAN: <one line on what you checked>. Never pad a clean result with weak findings.',
        ].join('\n'),
        tools: [hands.search, hands.read],
      });

      const clone = node({ id: 'clone', type: 'tool', toolId: 'clone_repo', tools: [cloneTool] });
      const worker = node({
        id: 'audit_worker',
        agent: auditor,
        failurePolicy: { timeoutMs: 1_200_000 },
        reads: [clone.result],
        writes: 'audit_report',
        // Lessons from earlier audits, eval-gated: what got dropped for
        // missing evidence, which charters keep coming back clean.
        ...(env.memory ? { memoryQuery: { tags: ['wf:repo-audit'], maxFacts: 8 } } : {}),
      });

      const audit = mapReduce('audit_worker', {
        id: 'audit',
        items: `$.memory.${clone.result}.charters`,
        concurrency: p.concurrency,
        maxItems: 32,
        onError: 'best_effort',
        taskTimeoutMs: 1_200_000,
        reads: [clone.result],
      });
      const sift = node({
        id: 'sift',
        type: 'tool',
        toolId: 'sift_findings',
        tools: [siftTool],
        reads: [audit.results, audit.errorCount],
      });

      // Cross-run learning tail — see docs-workflow for the pattern.
      const distiller = agent({
        id: 'repo-audit-lesson-distiller',
        name: 'Audit lesson distiller',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 1,
        instructions: [
          'You distill a repository-audit run\'s sift accounting into transferable lessons for future auditors.',
          'The sift result shows what survived and why findings were dropped: malformed blocks, evidence naming no real path, duplicates, already-filed, plus which reports came back clean.',
          'A lesson is one present-tense sentence that would change how the NEXT audit works: a reporting-format failure and its remedy, a charter that repeatedly turns up nothing, an evidence pattern that survives the sift.',
          'Never include run-specific details (finding titles, dates). Return no facts when nothing transferable happened.',
        ].join(' '),
      });
      const reflect = env.memory
        ? reflection([sift.result], {
            id: 'reflect',
            reads: [sift.result],
            failurePolicy: { maxRetries: 2 },
            extractor: { type: 'llm', agentId: distiller, maxFacts: 3 },
            tags: [LESSON_TAG, 'wf:repo-audit', CANDIDATE_TAG],
          })
        : undefined;

      const gate = verifier.expression(
        `memory.${sift.result}.ok`,
        {
          id: 'gate',
          reads: [sift.result],
          description: 'The fan-out produced auditor reports and the issue ledger was readable',
        },
      );
      const ticket = node({
        id: 'ticket',
        type: 'tool',
        toolId: 'file_tickets',
        tools: [ticketTool],
        reads: [sift.result],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'repo-audit',
          description: 'Fan out read-only auditors; sifted, evidence-checked findings become tickets.',
          nodes: [clone, audit, worker, sift, ...(reflect ? [reflect] : []), gate, ticket, report],
          edges: [
            { from: clone, to: audit },
            { from: audit, to: sift },
            // Learning sits between sift and gate so clean audits teach
            // too — "this charter came back clean again" is a lesson.
            ...(reflect
              ? [{ from: sift, to: reflect }, { from: reflect, to: gate }]
              : [{ from: sift, to: gate }]),
            {
              from: gate,
              to: ticket,
              when: `memory.gate_verification_passed and memory.${sift.result}.kept_count > 0`,
            },
            // A clean audit and a failed fan-out both end at report; the
            // gate boolean and the sift accounting say which happened.
            {
              from: gate,
              to: report,
              when: `not memory.gate_verification_passed or memory.${sift.result}.kept_count == 0`,
            },
            { from: ticket, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        input: {
          goal: `Audit the repository under up to ${p.maxAuditors} charters and file the strongest findings.`,
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
          maxIterations: 9,
        },
        runner: {},
      };
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

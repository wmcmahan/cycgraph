/**
 * docs-maintenance — a workflow that keeps this repository's docs honest.
 *
 * A workflow of ours, not a product feature: the detectors encode what
 * staleness means here. It speaks engine vocabulary only — the graph
 * from `@cycgraph/orchestrator`, jailed workspace tools and git delivery
 * helpers from `@cycgraph/tools` — so any harness can run it; the
 * playground registry wraps it into the studio's catalog contract.
 *
 * The first of the maintenance workflows, and the pattern the others
 * copy. It takes up to `batch` mechanically-detected findings per run,
 * fixes each in a disposable clone, and proves every fix by re-scanning:
 * the targeted finding is gone, nothing new appeared, and the
 * repository's own checks still pass. Each verified fix is its own
 * commit on one branch; the run ends with one pull request, and the
 * human gate is the merge. `publish: false` restores the commit-and-stop
 * boundary. Findings in files an open `docs/*` PR already touches are
 * deferred rather than redone, and `since` narrows a run to findings a
 * recent change plausibly staled — the push-triggered diff mode.
 *
 * That verdict is what makes the workflow improvable. Its `evals` assert
 * the fix resolved, so the tune loop can vary the fixer's prompt, model,
 * or iteration cap and know whether the change helped, and the whole
 * thing can run unattended under `studio loop`.
 *
 * @module maintenance/docs-workflow
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agent, graph, node, tool, verifier } from '@cycgraph/orchestrator';
import {
  diagnosticsTool,
  editFileTool,
  readFileTool,
  searchTool,
  createWorkspaceSession,
} from '@cycgraph/tools/workspace';
import { readFile } from 'node:fs/promises';
import { findingKey, judgeFix, scanDocs, scopeFindings, type DocsFinding } from './docs-scan.js';
import { resolveRepo } from './repo.js';
import { deliveryNodes, openPrFiles } from '@cycgraph/tools/git';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';
import type { EvalAssertion } from '@cycgraph/orchestrator';

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose documentation is maintained. Empty means the repository this runs inside'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before a fix may be committed, e.g. ["npm run lint"]'),
  skip: z.number().int().min(0).default(0)
    .describe('Findings to skip, so a second run can take the next one'),
  commit: z.boolean().default(true)
    .describe('Commit the verified fix to a branch. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push the committed branch to origin and open a pull request. Off leaves the prepared publish script in the commit result'),
  prompt: z.string().default('')
    .describe('Override the fixer agent\'s instructions. Empty uses the built-in prompt. A config knob so the tune loop can sweep it'),
  batch: z.number().int().min(1).max(10).default(1)
    .describe('Findings to fix in one run: one branch, one commit per verified fix, one pull request'),
  since: z.string().default('')
    .describe('Diff mode: a git ref. Only findings a change since that ref plausibly staled are taken'),
  budgetTokens: z.number().int().min(0).default(200000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

type Params = z.infer<typeof params>;

/** Configuration that splits the docs family into thin scenarios. */
export interface DocsMaintenanceOptions {
  id?: string;
  title?: string;
  /** Scan only documents under these paths. Empty scans everywhere. */
  roots?: string[];
  /** Never scan documents under these paths. */
  exclude?: string[];
}

/**
 * The docs-maintenance workflow.
 *
 * Exposed as a factory rather than a value because the workspace tools
 * are jailed to a clone path chosen per build, exactly as the improve
 * ladder's editor is. `repoDocsMaintenance` and `websiteDocsMaintenance`
 * are the two registered variants; each is this workflow with a scope.
 */
export function docsMaintenance(options: DocsMaintenanceOptions = {}): MaintenanceWorkflow<typeof params> {
  const id = options.id ?? 'docs-maintenance';
  return {
    id,
    title: options.title ?? 'Fix one stale thing the documentation claims',
    covers: ['maintenance', 'docs', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      // Chosen now, materialised by the `clone` node: the fixer's tools
      // must be jailed to a path before the clone exists.
      const workspaceAt = join(tmpdir(), `cycgraph-docs-${randomUUID()}`);
      const branchName = `docs/${id}-${randomUUID().slice(0, 8)}`;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
        edit: editFileTool({ root: workspaceAt, session }),
      };

      // The shared delivery tail: clone at the start, commit and publish
      // after the gate. The judge's verdict detail becomes the commit
      // message body and the PR evidence.
      const delivery = deliveryNodes({
        repoRoot,
        workspaceAt,
        branch: branchName,
        title: p.batch > 1 ? 'docs: correct stale references' : 'docs: correct a stale reference',
        detailFrom: 'judge_result',
        evidence: (details: string[]) => ({
          summary: details.length === 1
            ? `Found and verified by the ${id} workflow. ${details[0]}`
            : `Found and verified by the ${id} workflow: ${details.length} documentation fixes, one commit each.`,
          ...(details.length > 0 ? { changes: details } : {}),
          provenance: `${id}: each finding was detected mechanically, fixed by an agent in a jailed clone, and verified by re-scan and repository checks before its commit.`,
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      // Fetched once per run, not per cycle: the open-PR claim set and
      // the diff-mode changed-path set do not move mid-run.
      let deferredFetched = false;
      let deferred: string[] | undefined;
      let changed: string[] | undefined;

      // Scan and judge must look through the same scope: an out-of-scope
      // finding the scan never reported would otherwise be counted by the
      // judge's re-scan as newly introduced.
      const scopedScan = async () => scopeFindings(await scanDocs(workspaceAt), {
        ...(options.roots !== undefined ? { roots: options.roots } : {}),
        ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
        ...(deferred !== undefined ? { deferredFiles: deferred } : {}),
        ...(changed !== undefined ? { changedPaths: changed } : {}),
      });

      const scanTool = tool({
        name: 'scan_docs',
        description: 'Find what the documentation claims that the repository contradicts.',
        parameters: z.object({ commit_result: z.unknown().optional() }),
        execute: async ({ commit_result }) => {
          if (!deferredFetched) {
            deferredFetched = true;
            deferred = await openPrFiles(repoRoot, 'docs/');
          }
          if (p.since !== '' && changed === undefined) {
            const { stdout } = await promisify(execFile)(
              'git', ['diff', '--name-only', `${p.since}..HEAD`], { cwd: workspaceAt },
            );
            changed = stdout.split('\n').filter(Boolean);
          }
          const findings = await scopedScan();
          const finding = findings[p.skip];
          const fixedSoFar = (commit_result as { count?: number } | undefined)?.count ?? 0;
          const text = finding
            ? await readFile(join(workspaceAt, finding.file), 'utf8').catch(() => '')
            : '';
          return {
            total: findings.length,
            has_finding: finding !== undefined,
            any_fixed: fixedSoFar > 0,
            findings: findings.slice(0, 20),
            // Complete, uncapped: the judge needs every before-key or
            // findings past the display cap read as introduced.
            finding_keys: findings.map(findingKey),
            ...(finding ? { finding, text } : {}),
            instruction: finding
              ? [
                `In ${finding.file}, line ${finding.line}: ${finding.detail}`,
                `The document says '${finding.target}'.`,
                finding.candidates.length > 0
                  ? `The repository actually has: ${finding.candidates.join(' | ')}. Pick whichever the sentence means and edit the document to say that.`
                  : 'Search the repository for where that thing lives now, and edit the document to match.',
                'Replace the wrong reference with the right one. Do not delete the sentence, and do not replace an instruction with a comment.',
                'Change nothing else.',
              ].join('\n')
              : 'Nothing to fix: the documentation matches the repository.',
          };
        },
      });

      const judgeTool = tool({
        name: 'judge_fix',
        description: 'Re-scan and decide whether the targeted finding is gone.',
        parameters: z.object({ scan_result: z.unknown().optional() }),
        // A tool node's read keys arrive as its arguments; tools get no
        // ambient access to memory.
        execute: async ({ scan_result }) => {
          const before = scan_result as
            { finding?: DocsFinding; findings?: DocsFinding[]; finding_keys?: string[]; text?: string } | undefined;
          const targeted = before?.finding;
          if (!targeted) return { resolved: false, weakened: false, detail: 'nothing was targeted' };
          const after = await scopedScan();
          const afterText = await readFile(join(workspaceAt, targeted.file), 'utf8').catch(() => '');
          return judgeFix(targeted, before?.findings ?? [], after, {
            before: before?.text ?? '',
            after: afterText,
          }, before?.finding_keys);
        },
      });

      const checksTool = diagnosticsTool({
        name: 'repo_checks',
        cwd: workspaceAt,
        // A docs fix should not be able to break the build; when a project
        // declares no checks this is a no-op that always passes.
        command: p.checks.length > 0 ? 'sh' : 'true',
        ...(p.checks.length > 0 ? { args: ['-c', p.checks.join(' && ')] } : { args: [] }),
        timeoutMs: 600_000,
      });

      const fixer = agent({
        id: 'docs-fixer',
        name: 'Documentation fixer',
        model: env.model,
        provider: env.provider,
        temperature: 0.1,
        instructions: p.prompt !== '' ? p.prompt : [
          'You correct one stale claim in a documentation file so it matches the repository.',
          'Use search to find where the referenced thing actually lives, read_file to confirm, and edit_file to correct the document.',
          'The find text must be the file’s exact bytes as read_file shows them: never include line-number prefixes from search results, and never change indentation.',
          'If edit_file refuses because the find text matches more than one place, do not retry the same find and never try a different path: read the file, then use a longer find that includes the whole line and enough neighbouring text to match exactly once.',
          'Correct only the claim you were given. Do not rewrite prose, reformat, or fix anything else.',
          'Correct the claim — do not delete it. Replace a wrong path, link, or command with the right one; only remove a claim when the thing it describes genuinely no longer exists anywhere, and never replace an instruction with a comment.',
          'If your previous attempt is reported as removed rather than corrected, put a real reference back.',
          'When the edit is made, reply with one line: FIXED <file>.',
        ].join(' '),
        tools: [hands.search, hands.read, hands.edit],
      });

      const { clone, commit, publish } = delivery;
      const scan = node({ id: 'scan', type: 'tool', toolId: 'scan_docs', tools: [scanTool], reads: ['commit_result'] });
      const fix = node({
        id: 'fix',
        agent: fixer,
        failurePolicy: { timeoutMs: 600_000 },
        reads: [scan.result, 'judge_result'],
        writes: 'fix_report',
      });
      const judge = node({ id: 'judge', type: 'tool', toolId: 'judge_fix', tools: [judgeTool], reads: [scan.result] });
      const checks = node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [checksTool], reads: [] });
      const gate = verifier.expression(
        `memory.${judge.result}.resolved and not memory.${judge.result}.weakened`
          + ` and memory.${judge.result}.introduced_count == 0 and memory.${checks.result}.clean`,
        {
          id: 'gate',
          reads: [judge.result, checks.result],
          description: 'The claim was corrected rather than deleted, nothing new broke, and the checks still pass',
        },
      );
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: id,
          description: 'Fix mechanically-detected documentation staleness, and prove each fix.',
          nodes: [clone, scan, fix, judge, checks, gate, commit, publish, report],
          edges: [
            { from: clone, to: scan },
            { from: scan, to: fix, when: `memory.${scan.result}.has_finding` },
            // Out of findings after fixing some: deliver what landed.
            {
              from: scan,
              to: publish,
              when: `not memory.${scan.result}.has_finding and memory.${scan.result}.any_fixed`,
            },
            // Nothing to fix at all is a clean outcome, not a failure.
            {
              from: scan,
              to: report,
              when: `not memory.${scan.result}.has_finding and not memory.${scan.result}.any_fixed`,
            },
            { from: fix, to: judge },
            { from: judge, to: checks },
            { from: checks, to: gate },
            { from: gate, to: commit, when: 'memory.gate_verification_passed' },
            // A fix that did not land goes back for another attempt, bounded
            // by the run's iteration cap.
            { from: gate, to: fix, when: 'not memory.gate_verification_passed' },
            // Batch: rescan for the next finding until the quota is met.
            // The re-scan no longer reports what earlier cycles fixed, so
            // the next finding is simply the first eligible one again.
            {
              from: commit,
              to: scan,
              when: `memory.${commit.result}.committed and memory.${commit.result}.count < ${p.batch}`,
            },
            {
              from: commit,
              to: publish,
              when: `not memory.${commit.result}.committed or memory.${commit.result}.count >= ${p.batch}`,
            },
            { from: publish, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        input: {
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
          goal: p.batch > 1
            ? `Correct up to ${p.batch} stale claims in the documentation.`
            : 'Correct one stale claim in the documentation.',
          maxIterations: 12 + p.batch * 10,
        },
        runner: {},
      };
    },

    // The verdict is mechanical, so the workflow can be measured and tuned
    // like any other. The assertion that matters is the objective one: the
    // claim was corrected. Asserting only that the run completed would pass
    // a run that gave up, and asserting the finding is merely gone would
    // pass a deletion.
    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'judge_result' },
      // The gate's own boolean is the objective signal: it passes only when
      // the claim was corrected rather than deleted and the checks held.
      // `regex` mode compares strings, so asserting against the verdict
      // object would silently never match however good the fix was.
      { type: 'memory_matches', key: 'gate_verification_passed', mode: 'exact', expected: true, pattern: '' },
    ],
  };
}

/** The repository's own docs: READMEs, guides, everything outside the website. */
export function repoDocsMaintenance(): MaintenanceWorkflow<typeof params> {
  return docsMaintenance({
    id: 'repo-docs',
    title: 'Fix stale claims in the repository docs',
    exclude: ['apps/docs'],
  });
}

/** The documentation website under apps/docs. */
export function websiteDocsMaintenance(): MaintenanceWorkflow<typeof params> {
  return docsMaintenance({
    id: 'website-docs',
    title: 'Fix stale claims in the website docs',
    roots: ['apps/docs'],
  });
}

/**
 * issue-fix — the fix cycle over approved upkeep issues.
 *
 * core-upkeep files what the codebase owes; a human approves an issue
 * by labelling it; this workflow does the work. One issue per run: pick
 * the oldest approved issue carrying a finding marker, re-locate the
 * finding in a fresh clone (an issue whose finding is already gone
 * routes to a clean exit), fix it with an agent, judge with the class's
 * anti-gaming guard (`issue-judge.ts`), run the repository's checks,
 * pass a toolless reviewer over the actual diff (advisory, bounded
 * rounds — the mechanical gate stays the gate), and deliver one PR
 * whose body closes the issue. The human gates are the label going in
 * and the merge coming out.
 *
 * With no readable ledger, `--key` runs the same cycle detached — the
 * finding named directly, nothing closed — which is what makes the
 * loop testable without GitHub. An `audit:` key carries no file and no
 * specification, so detached mode pairs it with `--ticketFile`, whose
 * contents are the finding's issue text.
 *
 * @module maintenance/issue-fix
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { agent, graph, node, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { deliveryNodes, listOpenIssues, pendingDiff } from '@cycgraph/tools/git';
import {
  createFileTool,
  createWorkspaceSession,
  diagnosticsTool,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import { scanCore, type CoreFinding } from './core-scan.js';
import { auditTitle, severityRank } from './audit-findings.js';
import { findingFromKey, judgeAuditFix, judgeIssueFix, nextGateAttempt, parseIssueFinding, type IssueFinding } from './issue-judge.js';
import { checksEnv, CHANGESET_INSTRUCTION, NEEDS_HUMAN_LABEL, STANDARDS_BRIEF, flagNeedsHuman, resolveRepo } from './repo.js';
import { LESSON_TAG, MAINT_TAG } from './memory.js';
import { stripCloses, templateEvidence } from './pr-template.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose approved upkeep is fixed. Empty means the repository this runs inside'),
  label: z.string().default('maintenance-approved')
    .describe('Only issues carrying this label are picked up — the human approval gate'),
  issueNumber: z.number().int().min(0).default(0)
    .describe('Fix this specific issue. Zero picks the oldest approved one'),
  key: z.string().default('')
    .describe('Detached mode: fix this finding key directly, without reading or closing any issue'),
  ticketFile: z.string().default('')
    .describe('The issue body backing a detached --key, read from this file. Required for `audit:` keys'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before a fix may be committed, e.g. ["npm run lint"]'),
  lint: z.boolean().default(true)
    .describe('Include the eslint sense class in the baseline and judge scans'),
  commit: z.boolean().default(true)
    .describe('Commit the verified fix to a branch. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push the committed branch to origin and open a pull request'),
  prompt: z.string().default('')
    .describe('Override the fixer agent\'s instructions. Empty uses the built-in prompt'),
  // Sized for the graph's own worst case: three gate-bounded fix passes
  // plus the review loop, at roughly 150k billed tokens per pass.
  budgetTokens: z.number().int().min(0).default(1_500_000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

type Params = z.infer<typeof params>;

const GUIDANCE: Record<CoreFinding['kind'], string> = {
  todo: 'Do the work the comment describes, then remove the comment. Removing the comment without doing the work will be refused.',
  'skipped-test': 'Remove the .skip so the test runs, and make it pass by fixing whatever it exercises. Deleting the test will be refused.',
  'lint-warning': 'Fix the code the warning points at. Adding an eslint-disable comment or touching lint configuration will be refused.',
};

/** Commit subject for a resolved mechanical finding, by its class. */
const MECHANICAL_SUBJECTS: Record<string, (file: string) => string> = {
  todo: (file) => `chore: complete the TODO in ${file}`,
  'skipped-test': (file) => `test: revive the skipped test in ${file}`,
  'lint-warning': (file) => `fix: clear the lint warning in ${file}`,
};

const AUDIT_GUIDANCE = [
  'This finding came from a model-driven audit: the issue text above is the whole specification.',
  'First confirm the finding against the paths its evidence section names; then fix the root cause it describes, following the suggested fix where it is sound.',
  'A reviewer will compare your diff against the finding — a change that skirts the described problem will be refused.',
].join(' ');

/** The issue-fix workflow. */
export function issueFix(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'issue-fix',
    title: 'Fix one approved upkeep issue',
    covers: ['maintenance', 'upkeep', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-issue-fix-${randomUUID()}`);
      const branchName = `upkeep/fix-${randomUUID().slice(0, 8)}`;
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
        edit: editFileTool({ root: workspaceAt, session }),
        create: createFileTool({ root: workspaceAt, session }),
      };

      const delivery = deliveryNodes({
        repoRoot,
        workspaceAt,
        branch: branchName,
        title: 'chore: resolve owed upkeep',
        detailFrom: 'judge_result',
        evidence: (details: string[], context: { diff: string; subjects: string[] }) => ({
          summary: `Filed by maintenance discovery (core-upkeep or repo-audit), approved by label, fixed by the issue-fix workflow. ${stripCloses(details).join(' ')}`.trim(),
          // The commit subjects name the changes; the judge's verdict
          // prose stays in the summary where it reads as provenance.
          ...(context.subjects.length > 0
            ? { changes: context.subjects }
            : details.length > 0 ? { changes: stripCloses(details) } : {}),
          provenance: 'issue-fix: the finding was re-located mechanically, fixed by an agent in a jailed clone, and verified by re-scan, a class-specific anti-gaming guard, and repository checks before commit.',
          ...templateEvidence(context.diff, { checks: p.checks, reviewed: true, details }),
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      // Held outside the graph so onFatal can reach it: an engine-level
      // death (budget exhaustion) never executes the give_up node, and
      // the state it would have read dies with the run.
      let pickedIssue: number | undefined;

      const pickTool = tool({
        name: 'pick_issue',
        description: 'Pick the oldest approved upkeep issue, or run detached on a named key.',
        parameters: z.object({}),
        timeoutMs: 60_000,
        execute: async () => {
          const issues = await listOpenIssues(repoRoot, {
            label: p.label,
            ...(token !== undefined ? { token } : {}),
          });
          if (issues !== undefined) {
            const candidates = issues
              .filter((issue) => p.issueNumber === 0 || issue.number === p.issueNumber)
              // An issue the loop already gave up on waits for a human;
              // removing the label re-queues it, and naming the issue
              // explicitly overrides the skip — a targeted dispatch is
              // the human deciding.
              .filter((issue) => p.issueNumber !== 0 || !issue.labels.includes(NEEDS_HUMAN_LABEL))
              .flatMap((issue) => {
                const finding = parseIssueFinding(issue.body);
                return finding !== undefined ? [{ issue, finding }] : [];
              })
              // Queue order: worst severity label first, oldest within.
              .sort((a, b) =>
                severityRank(a.issue.labels) - severityRank(b.issue.labels)
                || a.issue.number - b.issue.number);
            const picked = candidates[0];
            if (picked === undefined) {
              return { has_work: false, detail: `no open '${p.label}' issue carries a finding marker` };
            }
            pickedIssue = picked.issue.number;
            return {
              has_work: true,
              issue_number: picked.issue.number,
              ...picked.finding,
              // An audit finding lives in its issue text, not in the tree;
              // carry it forward so the baseline can brief the fixer.
              ...(picked.finding.kind === 'audit'
                ? { issue_title: picked.issue.title, issue_body: picked.issue.body.slice(0, 12_000) }
                : {}),
            };
          }
          if (p.key !== '') {
            const finding = findingFromKey(p.key);
            if (finding === undefined) {
              return {
                has_work: false,
                detail: `'${p.key}' is not a finding key ('<kind>:<file>:<detail>' or 'audit:<title-slug>')`,
              };
            }
            // `audit:<title-slug>` carries no file component and no
            // specification: an audit finding's evidence, detail and
            // suggestion live only in its issue text, so detached mode
            // needs that body handed in rather than guessed from the key.
            if (finding.kind === 'audit') {
              const body = p.ticketFile !== '' ? await readFile(p.ticketFile, 'utf8') : '';
              if (body.trim() === '') {
                return {
                  has_work: false,
                  detail: `'${p.key}' is an audit finding: its specification is the issue text, so detached mode needs --ticketFile carrying that body — the key alone is insufficient`,
                };
              }
              return {
                has_work: true,
                detached: true,
                ...finding,
                issue_title: auditTitle(body, p.key),
                issue_body: body.slice(0, 12_000),
              };
            }
            return { has_work: true, detached: true, ...finding };
          }
          return { has_work: false, detail: 'cannot read the issue ledger and no --key was given' };
        },
      });

      const baselineTool = tool({
        name: 'baseline_scan',
        description: 'Re-locate the picked finding in the clone and record the before state.',
        parameters: z.object({ pick_result: z.unknown().optional() }),
        timeoutMs: 300_000,
        execute: async ({ pick_result }) => {
          const pick = pick_result as
            { key?: string; kind?: string; issue_number?: number; issue_title?: string; issue_body?: string } | undefined;
          const findings = await scanCore(workspaceAt, { lint: p.lint });
          if (pick?.kind === 'audit') {
            const spec = pick.issue_body ?? '';
            // The audit finding's issue text IS the specification; with
            // none of it there is nothing to brief the fixer with, so
            // the run exits visibly rather than fixing an empty spec.
            if (spec.trim() === '') {
              return {
                has_target: false,
                keys: findings.map((f) => f.key),
                detail: `'${pick.key ?? ''}' is an audit finding whose issue text did not reach the scan — its specification cannot be reconstructed from the key`,
              };
            }
            return {
              has_target: true,
              audit: true,
              keys: findings.map((f) => f.key),
              instruction: [
                `Resolve the audited finding this approved issue describes.`,
                `# ${pick.issue_title ?? pick.key ?? ''}`,
                spec,
                AUDIT_GUIDANCE,
                'Change nothing unrelated.',
              ].join('\n'),
            };
          }
          // The marker key is whatever was written when the issue was
          // filed, so a long-text finding filed before keys carried a
          // digest is only findable under its pre-digest form.
          const target = findings.find(
            (finding) => finding.key === pick?.key || finding.legacyKey === pick?.key,
          );
          if (target === undefined) {
            return {
              has_target: false,
              keys: findings.map((f) => f.key),
              detail: `'${pick?.key ?? ''}' is not present in the current tree — the issue may already be resolved; close it by hand`,
            };
          }
          const text = await readFile(join(workspaceAt, target.file), 'utf8').catch(() => '');
          return {
            has_target: true,
            keys: findings.map((f) => f.key),
            target,
            text,
            instruction: [
              `In ${target.file}, line ${target.line}: ${target.detail}`,
              GUIDANCE[target.kind],
              'Change nothing unrelated.',
            ].join('\n'),
          };
        },
      });

      const judgeTool = tool({
        name: 'judge_fix',
        description: 'Re-scan and decide whether the finding was resolved without gaming its class.',
        parameters: z.object({
          pick_result: z.unknown().optional(),
          baseline_result: z.unknown().optional(),
          judge_result: z.object({ attempts: z.number() }).partial().optional(),
          gate_verification_passed: z.boolean().optional(),
        }),
        timeoutMs: 300_000,
        execute: async ({ pick_result, baseline_result, judge_result, gate_verification_passed }) => {
          const pick = pick_result as { issue_number?: number; issue_title?: string } | undefined;
          const attempts = nextGateAttempt({
            previousAttempts: judge_result?.attempts ?? 0,
            gatePassed: gate_verification_passed,
          });
          const baseline = baseline_result as
            { keys?: string[]; target?: CoreFinding; text?: string; audit?: boolean } | undefined;
          const closesPrefix = pick?.issue_number !== undefined ? `Closes #${pick.issue_number}. ` : '';
          if (baseline?.audit === true) {
            const afterAudit = await scanCore(workspaceAt, { lint: p.lint });
            const verdict = judgeAuditFix({
              beforeKeys: baseline.keys ?? [],
              afterKeys: afterAudit.map((f) => f.key),
              diff: await pendingDiff(workspaceAt),
            });
            return {
              ...verdict,
              attempts,
              detail: `${closesPrefix}${verdict.detail}`,
              // The issue title names the finding, so the commit inherits it.
              ...(pick?.issue_title !== undefined && pick.issue_title !== ''
                ? { subject: `fix: ${pick.issue_title}` }
                : {}),
            };
          }
          const target = baseline?.target;
          if (target === undefined) return { resolved: false, weakened: false, attempts, detail: 'nothing was targeted' };

          const finding: IssueFinding = { key: target.key, kind: target.kind, file: target.file };
          const after = await scanCore(workspaceAt, { lint: p.lint });
          const afterText = await readFile(join(workspaceAt, target.file), 'utf8').catch(() => '');
          const verdict = judgeIssueFix({
            finding,
            beforeKeys: baseline?.keys ?? [],
            afterKeys: after.map((f) => f.key),
            text: { before: baseline?.text ?? '', after: afterText },
            diff: await pendingDiff(workspaceAt),
          });
          // "Closes #N" in the verdict detail reaches the PR body through
          // the delivery evidence, which is what closes the issue on merge.
          const closes = pick?.issue_number !== undefined ? `Closes #${pick.issue_number}. ` : '';
          const subject = MECHANICAL_SUBJECTS[target.kind]?.(target.file);
          return {
            ...verdict,
            attempts,
            detail: `${closes}${verdict.detail}`,
            ...(subject !== undefined ? { subject } : {}),
          };
        },
      });

      const checksTool = diagnosticsTool({
        name: 'repo_checks',
        cwd: workspaceAt,
        command: p.checks.length > 0 ? 'sh' : 'true',
        ...(p.checks.length > 0 ? { args: ['-c', p.checks.join(' && ')] } : { args: [] }),
        // Sized for the full test suite, not just lint.
        timeoutMs: 1_800_000,
        maxLines: 120,
        env: checksEnv(),
      });

      // The first check command doubles as the fixer's own probe: an
      // agent that cannot compile what it edits fails the later gate
      // blind, and three blind gate cycles cost far more than in-pass
      // probe calls. The full trio still runs at the gate; this is the
      // fast subset, and its incremental state warms across calls.
      const probeTool = diagnosticsTool({
        name: 'workspace_check',
        cwd: workspaceAt,
        command: p.checks.length > 0 ? 'sh' : 'true',
        ...(p.checks.length > 0 ? { args: ['-c', p.checks[0]!] } : { args: [] }),
        timeoutMs: 600_000,
        env: checksEnv(),
      });

      const diffTool = tool({
        name: 'workspace_diff',
        description: 'The workspace\'s full uncommitted diff, for review.',
        parameters: z.object({}),
        execute: async () => {
          const diff = await pendingDiff(workspaceAt);
          return { diff: diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n… (truncated)` : diff };
        },
      });

      const giveUpTool = tool({
        name: 'give_up',
        description: 'Flag the picked issue as waiting on a human when the run cannot deliver a pull request.',
        parameters: z.object({
          pick_result: z.unknown().optional(),
          baseline_result: z.unknown().optional(),
          judge_result: z.object({ attempts: z.number() }).partial().optional(),
          checks_result: z.unknown().optional(),
          review_check_result: z.unknown().optional(),
        }),
        timeoutMs: 60_000,
        execute: async ({ pick_result, baseline_result, judge_result, checks_result, review_check_result }) => {
          const issue = (pick_result as { issue_number?: number } | undefined)?.issue_number;
          if (issue === undefined) return { flagged: false, detail: 'detached run — nothing to flag' };
          const baseline = baseline_result as { has_target?: boolean; detail?: string } | undefined;
          const review = review_check_result as { approved?: boolean; round?: number; detail?: string } | undefined;
          // One node serves every dead end in the graph, so the comment
          // has to name which one sent the run here and carry that path's
          // evidence. The order mirrors the edge conditions: no target,
          // then the spent gate budget, then the unapproved review.
          const [cause, evidence] = baseline?.has_target === false
            ? ['the finding it names is no longer in the tree, so there is nothing to fix', String(baseline.detail ?? '')]
            : (judge_result?.attempts ?? 0) >= 3
              ? ['three consecutive gate failures without green checks', String((checks_result as { output?: unknown } | undefined)?.output ?? '')]
              : [`the reviewer never approved after ${String(review?.round ?? 0)} round(s)`, String(review?.detail ?? '')];
          const result = await flagNeedsHuman(repoRoot, issue, [
            `issue-fix ended without a pull request — ${cause} — so this issue now carries the \`needs-human\` label and the picker skips it.`,
            'Remove the label to re-queue it, close the issue if it is already settled, or investigate the evidence below.',
            '',
            '```',
            evidence.slice(-1_500),
            '```',
          ].join('\n'), token !== undefined ? { token } : {});
          return {
            flagged: result.flagged,
            issue_number: issue,
            detail: result.flagged ? `flagged #${issue}; ${result.detail}` : result.detail,
          };
        },
      });

      const reviewCheckTool = tool({
        name: 'review_check',
        description: 'Parse the reviewer\'s verdict and count review rounds.',
        parameters: z.object({
          review: z.unknown().optional(),
          review_check_result: z.unknown().optional(),
        }),
        execute: async ({ review, review_check_result }) => {
          const text = String(review ?? '');
          const round = ((review_check_result as { round?: number } | undefined)?.round ?? 0) + 1;
          const approved = /^\s*APPROVED/m.test(text);
          return {
            approved,
            round,
            detail: approved
              ? `review approved (round ${round})`
              : `review requested revisions (round ${round}): ${text.replace(/\n/g, ' ').slice(0, 240)}`,
          };
        },
      });

      const fixer = agent({
        id: 'upkeep-fixer',
        name: 'Upkeep fixer',
        model: env.model,
        provider: env.provider,
        temperature: 0.1,
        // Sized for edit rounds plus the probe-and-fix cycles the
        // workspace_check instruction asks for.
        maxSteps: 20,
        instructions: p.prompt !== '' ? p.prompt : [
          'You resolve one piece of owed upkeep in a codebase: a TODO to implement, a skipped test to revive, a lint warning to fix, or an audited finding whose specification is the issue text in your instructions.',
          'Use search to orient, read_file to see exact bytes, and edit_file to change them.',
          'The find text must be the file’s exact bytes as read_file shows them: never include line-number prefixes from search results, and never change indentation.',
          'If edit_file refuses because the find text matches more than one place, read the file and retry with a longer find that includes enough neighbouring text to match exactly once.',
          'Resolve the work, never erase its marker: the follow-up instruction states what counts as erasure for this finding, and erasure is refused.',
          'After your edits, run workspace_check and fix what it reports until it comes back clean — the gate re-runs a stricter version of the same checks, and a pass that ends with workspace_check red will fail it. Never reply FIXED without a clean workspace_check after your last edit.',
          'If a reviewer\'s findings are in your context, address exactly what they name and nothing more — unless a finding makes a factual claim about the wider tree (a dependency direction, an existing helper) that your tools show to be wrong: then verify, keep your fix, and state the disputing evidence in your reply (the file and line that disproves it).',
          STANDARDS_BRIEF,
          CHANGESET_INSTRUCTION,
          'Change nothing unrelated. When the fix is made, reply with one line: FIXED <file>.',
        ].join(' '),
        tools: [hands.search, hands.read, hands.edit, hands.create, probeTool],
      });

      // The reviewer is an advisory critic, not the verdict: the
      // mechanical gate stays the gate and the human merge stays the
      // judgment. Toolless and fed the actual diff, it exists to catch
      // what the class guards cannot — a hollow fix, collateral edits,
      // style foreign to the surrounding code.
      const reviewer = agent({
        id: 'upkeep-reviewer',
        name: 'Upkeep reviewer',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 2,
        instructions: [
          'You review one upkeep-fix diff against the finding it resolves. You have no tools; judge only what is in front of you.',
          'The fixer\'s report is beside the diff. It CAN read the tree and you cannot: when it disputes one of your prior findings with cited evidence (a path, a package.json line), weigh the evidence rather than repeating the finding.',
          STANDARDS_BRIEF,
          'Refuse anything a careful human reviewer would: work erased instead of done (a TODO removed without its work, a test deleted or hollowed instead of revived, an eslint-disable instead of a fix); tests that write, delete, or mutate source files or anything outside a temp directory; edits unrelated to the finding; style foreign to the surrounding codebase (comments narrating history, missing .js import extensions).',
          'Do not nitpick working code that a reasonable reviewer would pass; the goal is one round.',
          'Reply with exactly one of:',
          'APPROVED: <one line on why it is sound>',
          'REVISE:',
          '1. <specific finding with the file and what to change>',
        ].join('\n'),
        tools: [],
      });

      const { clone, commit, publish } = delivery;
      const pick = node({ id: 'pick', type: 'tool', toolId: 'pick_issue', tools: [pickTool], reads: [] });
      const baseline = node({
        id: 'baseline',
        type: 'tool',
        toolId: 'baseline_scan',
        tools: [baselineTool],
        reads: [pick.result],
      });
      const fix = node({
        id: 'fix',
        agent: fixer,
        failurePolicy: { timeoutMs: 1_200_000 },
        // checks_result rides the gate-retry: without it the fixer never
        // learns which tests its last attempt broke.
        reads: [baseline.result, 'judge_result', 'checks_result', 'review'],
        writes: 'fix_report',
        // The whole lesson pool, not a per-workflow tag: defect-class
        // lessons distilled from reviews apply to every editing agent.
        ...(env.memory ? { memoryQuery: { tags: [MAINT_TAG], maxFacts: 6 } } : {}),
      });
      const judge = node({
        id: 'judge',
        type: 'tool',
        toolId: 'judge_fix',
        tools: [judgeTool],
        reads: [pick.result, baseline.result, 'judge_result', 'gate_verification_passed'],
      });
      const checks = node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [checksTool], reads: [] });
      const gate = verifier.expression(
        `memory.${judge.result}.resolved and not memory.${judge.result}.weakened`
          + ` and memory.${judge.result}.introduced_count == 0 and memory.${checks.result}.clean`,
        {
          id: 'gate',
          reads: [judge.result, checks.result],
          description: 'The work was done rather than erased, nothing new broke, and the checks still pass',
        },
      );
      const diff = node({ id: 'diff', type: 'tool', toolId: 'workspace_diff', tools: [diffTool], reads: [] });
      const review = node({
        id: 'review',
        agent: reviewer,
        failurePolicy: { timeoutMs: 300_000 },
        reads: [baseline.result, diff.result, 'fix_report'],
        writes: 'review',
      });
      const reviewCheck = node({
        id: 'review_check',
        type: 'tool',
        toolId: 'review_check',
        tools: [reviewCheckTool],
        reads: ['review', 'review_check_result'],
      });
      const giveUp = node({
        id: 'giveup',
        type: 'tool',
        toolId: 'give_up',
        tools: [giveUpTool],
        reads: [pick.result, baseline.result, 'judge_result', 'checks_result', 'review_check_result'],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'issue-fix',
          description: 'Fix one approved upkeep issue and prove the work was done.',
          nodes: [clone, pick, baseline, fix, judge, checks, gate, diff, review, reviewCheck, giveUp, commit, publish, report],
          edges: [
            { from: clone, to: pick },
            { from: pick, to: baseline, when: `memory.${pick.result}.has_work` },
            // No approved work is a clean outcome, not a failure.
            { from: pick, to: report, when: `not memory.${pick.result}.has_work` },
            { from: baseline, to: fix, when: `memory.${baseline.result}.has_target` },
            // A finding already gone means the issue outlived its cause:
            // no PR is possible, and leaving the issue approved would let
            // the next dispatch pick the same one, so a human is flagged.
            { from: baseline, to: giveUp, when: `not memory.${baseline.result}.has_target` },
            { from: fix, to: judge },
            { from: judge, to: checks },
            { from: checks, to: gate },
            { from: gate, to: diff, when: 'memory.gate_verification_passed' },
            { from: diff, to: review },
            { from: review, to: reviewCheck },
            { from: reviewCheck, to: commit, when: `memory.${reviewCheck.result}.approved` },
            // Findings loop back to the fixer, bounded; a review that
            // never approves flags a human rather than delivering, so
            // the issue stops being the picker's top pick.
            {
              from: reviewCheck,
              to: fix,
              when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round < 3`,
            },
            {
              from: reviewCheck,
              to: giveUp,
              when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round >= 3`,
            },
            // Bounded at three CONSECUTIVE gate failures: each retry
            // re-runs the full checks, and `nextGateAttempt` restarts
            // the count whenever the previous gate passed, so the
            // review loop's re-judging never spends this budget.
            {
              from: gate,
              to: fix,
              when: 'not memory.gate_verification_passed and memory.judge_result.attempts < 3',
            },
            {
              from: gate,
              to: giveUp,
              when: 'not memory.gate_verification_passed and memory.judge_result.attempts >= 3',
            },
            { from: giveUp, to: report },
            { from: commit, to: publish },
            { from: publish, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        input: { goal: 'Resolve one approved upkeep issue.',
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}), maxIterations: 40 },
        runner: {},
        // An engine-level death (budget breach) bypasses the give_up
        // node, which would leave the picked issue approved-but-orphaned:
        // its label event already fired, so nothing re-queues it.
        onFatal: async (error: unknown) => {
          if (pickedIssue === undefined) return undefined;
          const issue = pickedIssue;
          try {
            const reason = error instanceof Error ? error.message : String(error);
            const result = await flagNeedsHuman(repoRoot, issue, [
              `issue-fix died before finishing (${reason}), so this issue now carries the \`needs-human\` label and the picker skips it.`,
              'Remove the label to re-queue it, or dispatch issue-fix naming this issue to override the skip.',
            ].join('\n'), token !== undefined ? { token } : {});
            return result.flagged
              ? `fatal-run cleanup: #${issue} flagged ${NEEDS_HUMAN_LABEL}`
              : `fatal-run cleanup on #${issue}: ${result.detail}`;
          } catch (cleanupError) {
            return `fatal-run cleanup failed on #${issue}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          }
        },
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'pick_result' },
    ],
  };
}

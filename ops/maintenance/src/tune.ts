/**
 * tune — the fleet proposing measured changes to its own source.
 *
 * The loop that closes recursive self-improvement at the structural
 * level: sense reads the scorecard and the target workflow's recent
 * failures from the recorded corpus; an analyst with read-only hands
 * locates the exact instruction text implicated and proposes one
 * find/replace edit with a hypothesis; trials run the target workflow
 * in dry mode as subprocesses — control and variant each from a clone
 * of the same committed base, differing only by the edit — so what is
 * measured is the real source change, end to end; and a variant that
 * wins becomes a ticket carrying the hypothesis, the measured table, and
 * the exact diff. Nothing lands without the `maintenance-approved`
 * label and a human merge, the same ladder as every other change.
 *
 * Trials run with the database credential stripped: they must neither
 * pollute the recorded corpus nor differ by lesson injection.
 *
 * @module maintenance/tune
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agent, graph, node, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { createIssue, findingMarker, issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { createWorkspaceSession, readFileTool, searchTool } from '@cycgraph/tools/workspace';
import { fetchStats, formatStats } from './stats.js';
import { checksEnv, maintenanceSecrets, resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const exec = promisify(execFile);

/**
 * The subprocess result envelope `run.ts` writes when
 * `MAINTAIN_RESULT_JSON` is set — one schema for both sides of the
 * process boundary.
 */
export const MaintainResultSchema = z.object({
  status: z.string(),
  gate: z.boolean().nullable(),
  tokens: z.number(),
  cost_usd: z.number(),
  /** True when the run flagged its picked issue needs-human instead of delivering. */
  gave_up: z.boolean().optional(),
  /**
   * A workflow-specific thoroughness count when the run produces one:
   * repo-audit's findings kept after the sift, or the docs family's
   * fixes committed. Absent for workflows with no such measure (a
   * single-proposal run). Tune uses it to refuse a cost win that
   * produced materially less than control.
   */
  yield: z.number().optional(),
});

/**
 * Workflows a tune run may target, with the flags that make a trial dry.
 *
 * The docs workflows commit into their own disposable clone (never push
 * — `--publish false`) across a `--batch` of findings so the trial
 * yields a fixes-landed count that varies with the fixer's thoroughness;
 * without a batch there is no count for a cost win to check against.
 */
export const TUNABLE: Record<string, string[]> = {
  // --budgetTokens is raised from the batch-1 default (400k) to cover
  // three fix-verify-commit cycles; a breach fails the run and would
  // measure nothing in either arm.
  'docs-maintenance': ['--commit', 'true', '--publish', 'false', '--batch', '3', '--budgetTokens', '1200000'],
  'repo-docs': ['--commit', 'true', '--publish', 'false', '--batch', '3', '--budgetTokens', '1200000'],
  'website-docs': ['--commit', 'true', '--publish', 'false', '--batch', '3', '--budgetTokens', '1200000'],
  'repo-audit': ['--file', 'false', '--maxAuditors', '2', '--steps', '16', '--budgetTokens', '600000'],
  'feat-propose': ['--file', 'false'],
};

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose maintenance source is tuned. Empty means the repository this runs inside'),
  target: z.enum(['docs-maintenance', 'repo-docs', 'website-docs', 'repo-audit', 'feat-propose']).default('docs-maintenance')
    .describe('The workflow whose prompts the tune run studies and trials'),
  trials: z.number().int().min(2).max(8).default(3)
    .describe('Dry runs per arm (control and variant). Small samples: the ticket carries the caveat and the human judges'),
  attempts: z.number().int().min(1).max(3).default(2)
    .describe('Proposal attempts before the run exits with no proposal'),
  file: z.boolean().default(true)
    .describe('File a winning proposal as a ticket. Off reports what would be filed'),
  prompt: z.string().default('')
    .describe('Override the analyst agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(500000)
    .describe('Hard token budget for the tune graph itself (trials are subprocesses, capped by their own flags). Zero removes the cap'),
});

type Params = z.infer<typeof params>;

// ─── pure parts ─────────────────────────────────────────────────────

/** One proposed source edit, recovered from the analyst's reply. */
export interface TuneProposal {
  hypothesis: string;
  file: string;
  find: string;
  replace: string;
}

/**
 * Parse the analyst's HYPOTHESIS / FILE / FIND / REPLACE blocks.
 * `<<<`/`>>>` fence the texts so multi-line instruction strings carry
 * verbatim. Returns what is missing when the shape is wrong.
 */
export function parseTuneProposal(text: string): { proposal?: TuneProposal; missing: string[] } {
  const hypothesis = /^HYPOTHESIS:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const file = /^FILE:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const fence = (label: string): string | undefined =>
    new RegExp(`^${label}:\\s*\\n<<<\\n([\\s\\S]*?)\\n>>>`, 'm').exec(text)?.[1];
  const find = fence('FIND');
  const replace = fence('REPLACE');

  const missing = [
    ...(hypothesis === '' ? ['HYPOTHESIS'] : []),
    ...(file === '' ? ['FILE'] : []),
    ...(find === undefined || find.trim() === '' ? ['FIND'] : []),
    ...(replace === undefined ? ['REPLACE'] : []),
  ];
  if (missing.length > 0) return { missing };
  if (find === replace) return { missing: ['a REPLACE that differs from FIND'] };
  return { proposal: { hypothesis, file, find: find!, replace: replace! }, missing: [] };
}

/**
 * The next ```-fenced block after `from`, and the index just past it.
 * Linear index scans, never a regex: the body is semi-trusted issue
 * text, and a greedy pattern over it is a ReDoS surface.
 */
function nextFence(body: string, from: number): { text: string; end: number } | undefined {
  const open = body.indexOf('```', from);
  if (open === -1) return undefined;
  const contentStart = body.indexOf('\n', open);
  if (contentStart === -1) return undefined;
  const close = body.indexOf('\n```', contentStart + 1);
  if (close === -1) return undefined;
  return { text: body.slice(contentStart + 1, close), end: close + 4 };
}

/**
 * Recover the `{ file, find, replace }` edit from a filed tune ticket's
 * body — the `**The edit** — in \`file\`, replace: <find fence> with:
 * <replace fence>` block the ticket tool renders. This is what lets the
 * apply step re-apply a tune proposal from its ticket, closing the
 * propose→approve→apply loop. Returns `undefined` when the block is
 * absent or malformed, so a non-tune ticket falls through cleanly.
 *
 * Parsed with index scans rather than a regex: the body is
 * semi-trusted issue text, so a backtracking pattern over it is a
 * denial-of-service surface (CWE-1333).
 */
/** The measured proposal and its trial evidence, as a tune ticket carries them. */
export interface TuneTicketFields {
  target: string;
  hypothesis: string;
  trials: number;
  trialDetail: string;
  trialTable: string;
  file: string;
  find: string;
  replace: string;
  /**
   * A cost win: the variant tied on gates and completions and only ran
   * cheaper. The rendered ticket flags it so a human knows to verify
   * the workflow is no less thorough before merging, rather than reading
   * it as a quality improvement.
   */
  costOnly: boolean;
  /** The finding marker line that keys and dedupes the ticket. */
  marker: string;
}

/**
 * Render a tune ticket's body. The one source of the format, shared by
 * the filer and {@link parseTuneTicket}'s tests, so a drift in the
 * layout breaks the round-trip test loudly instead of silently
 * defeating the parser.
 */
export function renderTuneTicket(fields: TuneTicketFields): string {
  return [
    `The tune loop proposes one edit to ${fields.target}'s own source, measured before proposal.`,
    '',
    ...(fields.costOnly
      ? ['**Cost win — verify before merging**: the variant did not improve gates or completions; it only ran cheaper. The benchmark cannot tell efficiency from doing less, so confirm this edit leaves the workflow no less thorough.', '']
      : []),
    `**Hypothesis**: ${fields.hypothesis}`,
    '',
    `**Trial** (${fields.trials} dry runs per arm — a small sample by design; this table is a filter, the merge decision is the judgment): ${fields.trialDetail}`,
    '',
    fields.trialTable,
    '',
    `**The edit** — in \`${fields.file}\`, replace:`,
    '```',
    fields.find,
    '```',
    'with:',
    '```',
    fields.replace,
    '```',
    '',
    'Approve with the `maintenance-approved` label; feat-implement applies it as any other approved ticket.',
    '',
    fields.marker,
  ].join('\n');
}

export function parseTuneTicket(body: string): { file: string; find: string; replace: string } | undefined {
  const marker = body.indexOf('**The edit**');
  if (marker === -1) return undefined;
  const openTick = body.indexOf('`', marker);
  if (openTick === -1) return undefined;
  const closeTick = body.indexOf('`', openTick + 1);
  if (closeTick === -1) return undefined;
  const file = body.slice(openTick + 1, closeTick).trim();
  if (file === '') return undefined;

  const findBlock = nextFence(body, closeTick + 1);
  if (findBlock === undefined) return undefined;
  const replaceBlock = nextFence(body, findBlock.end);
  if (replaceBlock === undefined) return undefined;
  if (findBlock.text === replaceBlock.text) return undefined;
  return { file, find: findBlock.text, replace: replaceBlock.text };
}

/**
 * Resolve a proposal's FILE against `root`, accepting it only when it
 * lands strictly inside `root`'s `sourceDir`.
 *
 * The proposal text is model-generated, and a trial writes to this path
 * for real inside its clone, so containment is decided on resolved
 * paths: `ops/maintenance/src/../../../package.json` and absolute paths
 * both satisfy a plain prefix test yet resolve outside the subtree.
 *
 * @param root - Directory the repo-relative `file` is resolved against.
 * @param sourceDir - Repo-relative subtree the file must stay inside.
 * @param file - The proposal's FILE value, untrusted.
 * @returns The absolute path inside `sourceDir`, or undefined when it escapes.
 */
export function resolveSourcePath(root: string, sourceDir: string, file: string): string | undefined {
  const dir = resolve(root, sourceDir);
  const at = resolve(root, file);
  return at.startsWith(dir + sep) ? at : undefined;
}

/** One trial arm's aggregates. */
export interface ArmResult {
  runs: number;
  completed: number;
  gatePassed: number;
  avgTokens: number;
  costUsd: number;
  /**
   * Total thoroughness count across the arm's runs — repo-audit's kept
   * findings, or the docs family's fixes committed — or `undefined`
   * when the target reports none. A cost win requires the variant's
   * yield to hold against control's.
   */
  yield?: number;
}

/**
 * How much cheaper the variant must run, at equal gates and completions,
 * to be worth a human-judged ticket: a cost drop below this fraction of
 * control is material enough that a person should decide whether it is
 * efficiency or a thoroughness regression.
 */
export const COST_WIN_RATIO = 0.75;

/**
 * Whether the variant beats control. A quality win is strictly more gate
 * passes, or equal gates with more completions. Absent that, a variant
 * that holds gates and completions but runs materially cheaper
 * ({@link COST_WIN_RATIO}) is a *cost win*: still filed, but flagged
 * `costOnly`, because the benchmark cannot tell real efficiency from a
 * variant that simply does less — that judgement is the human
 * reviewer's, and the ticket says so. When both arms report a
 * thoroughness count (`yield` — repo-audit's kept findings or the docs
 * family's fixes committed), a cost win additionally requires the
 * variant's yield to be no lower than control's; a cheaper variant that
 * produced less is refused, since that is the degradation the gate
 * cannot see. A cost drop is never a
 * silent auto-win against a gate or thoroughness regression. Small
 * samples by design; the verdict is a filter, the human judges.
 */
export function variantWins(control: ArmResult, variant: ArmResult): { wins: boolean; costOnly?: boolean; detail: string } {
  if (variant.completed < control.completed) {
    return { wins: false, detail: `variant completed ${variant.completed}/${variant.runs} vs control ${control.completed}/${control.runs}` };
  }
  if (variant.gatePassed > control.gatePassed) {
    return { wins: true, detail: `gate passes ${variant.gatePassed}/${variant.runs} vs ${control.gatePassed}/${control.runs}` };
  }
  if (variant.gatePassed === control.gatePassed && variant.completed > control.completed) {
    return { wins: true, detail: `completions ${variant.completed}/${variant.runs} vs ${control.completed}/${control.runs}, gates level` };
  }
  if (variant.gatePassed === control.gatePassed
    && variant.completed === control.completed
    // A crashed variant writes zero cost and zero completions, which
    // would otherwise read as "100% cheaper at equal gates" and file a
    // ticket for the edit that broke it. A cost win must have actually
    // run and actually spent.
    && variant.completed > 0
    && variant.costUsd > 0
    && control.costUsd > 0
    && variant.costUsd <= control.costUsd * COST_WIN_RATIO) {
    const pct = Math.round((1 - variant.costUsd / control.costUsd) * 100);
    // Yield parity: when both arms report a thoroughness count (kept
    // findings for repo-audit, fixes committed for the docs family), a
    // cheaper variant that produced materially less is thoroughness loss
    // wearing cheapness — not a win. The gate cannot see this; the
    // yield can.
    if (control.yield !== undefined && variant.yield !== undefined) {
      if (variant.yield < control.yield) {
        return { wins: false, detail: `${pct}% cheaper but produced less (${variant.yield} vs ${control.yield}) — likely less thorough, not a cost win` };
      }
      return {
        wins: true,
        costOnly: true,
        detail: `${pct}% cheaper at equal gates (${variant.gatePassed}/${variant.runs}), completions, and output (${variant.yield} vs ${control.yield}) — thoroughness held; still confirm before merging`,
      };
    }
    return {
      wins: true,
      costOnly: true,
      detail: `${pct}% cheaper at equal gates (${variant.gatePassed}/${variant.runs}) and completions — a cost win the gate cannot vouch for, so verify the workflow is no less thorough before merging`,
    };
  }
  return { wins: false, detail: `no improvement: gates ${variant.gatePassed}/${variant.runs} vs ${control.gatePassed}/${control.runs}` };
}

/** Stable dedupe key for one proposed edit. */
export function tuneKey(target: string, proposal: Pick<TuneProposal, 'file' | 'replace'>): string {
  const digest = createHash('sha256').update(`${proposal.file}\u0000${proposal.replace}`).digest('hex').slice(0, 12);
  return `tune:${target}:${digest}`;
}

// ─── the workflow ───────────────────────────────────────────────────

/** The tune workflow. */
export function tunePropose(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'tune',
    title: 'Propose one measured change to a workflow\'s own source',
    covers: ['maintenance', 'tuning'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const token = env.publish?.token;
      const sourceDir = 'ops/maintenance/src';

      const hands = {
        read: readFileTool({ root: repoRoot, session }),
        search: searchTool({ root: repoRoot }),
      };

      const senseTool = tool({
        name: 'sense_target',
        description: 'Read the scorecard and the target workflow\'s recent failures from the corpus.',
        parameters: z.object({}),
        timeoutMs: 120_000,
        execute: async () => {
          const stats = await fetchStats(14);
          const row = stats.find((entry) => entry.name === p.target);
          const { withTenant, SEED_TENANT_ID, graphs, workflow_runs, workflow_states } =
            await import('@cycgraph/orchestrator-postgres');
          const { sql } = await import('drizzle-orm');
          const failures = await withTenant(SEED_TENANT_ID, async (tx) => {
            const result = await tx.execute(sql`
              WITH latest AS (
                SELECT DISTINCT ON (ws.run_id) ws.run_id, ws.state
                FROM ${workflow_states} ws ORDER BY ws.run_id, ws.version DESC
              )
              SELECT r.status AS status,
                l.state->'memory'->>'gate_verification_passed' AS gate,
                left(l.state->'memory'->'judge_result'->>'detail', 200) AS judge,
                left(l.state->'memory'->'sift_result'->>'drops', 400) AS drops
              FROM ${workflow_runs} r
              JOIN ${graphs} g ON g.id = r.graph_id
              JOIN latest l ON l.run_id = r.id
              WHERE g.name = ${p.target} AND r.run_kind = 'primary'
                AND (r.status <> 'completed' OR (l.state->'memory'->>'gate_verification_passed') = 'false')
              ORDER BY r.created_at DESC LIMIT 8`);
            return result.rows as { status: string; gate: string | null; judge: string | null; drops: string | null }[];
          });
          return {
            has_signal: row !== undefined,
            scorecard: row !== undefined ? formatStats([row], 14).join('\n') : `no ${p.target} runs recorded in the window`,
            recent_failures: failures,
            instruction: [
              `Target workflow: ${p.target}. Its source lives under ${sourceDir}/ (the file names match the workflow id, e.g. audit-workflow.ts, docs-workflow.ts, feat-propose.ts).`,
              'Scorecard (last 14 days):',
              row !== undefined ? formatStats([row], 14).join('\n') : '(no runs recorded)',
              failures.length > 0
                ? `Recent failures and gate refusals:\n${failures.map((f, i) => `${i + 1}. status=${f.status} gate=${f.gate ?? '—'} ${f.judge ?? ''} ${f.drops ?? ''}`).join('\n')}`
                : 'No recent failures — look for efficiency or robustness improvements the instructions leave on the table.',
            ].join('\n'),
          };
        },
      });

      const shapeTool = tool({
        name: 'check_proposal',
        description: 'Validate the proposed edit: the file is maintenance source and the find-text exists verbatim.',
        parameters: z.object({ proposal: z.unknown().optional(), shape_result: z.unknown().optional() }),
        timeoutMs: 30_000,
        execute: async ({ proposal, shape_result }) => {
          const round = ((shape_result as { round?: number } | undefined)?.round ?? 0) + 1;
          const { proposal: parsed, missing } = parseTuneProposal(String(proposal ?? ''));
          if (parsed === undefined) {
            return { valid: false, round, detail: `missing ${missing.join(', ')} — reply with HYPOTHESIS:, FILE:, then FIND:/REPLACE: blocks fenced by <<< and >>> lines` };
          }
          const at = resolveSourcePath(repoRoot, sourceDir, parsed.file);
          if (at === undefined) {
            return { valid: false, round, detail: `FILE must resolve inside ${sourceDir}/ — the tune loop edits workflow source only, got '${parsed.file}'` };
          }
          if (!existsSync(at)) {
            return { valid: false, round, detail: `'${parsed.file}' does not exist` };
          }
          const content = await readFile(at, 'utf8');
          const occurrences = content.split(parsed.find).length - 1;
          if (occurrences === 0) {
            return { valid: false, round, detail: 'FIND does not appear in the file — quote the exact current text, character for character' };
          }
          if (occurrences > 1) {
            return { valid: false, round, detail: `FIND appears ${occurrences} times — include enough surrounding text to match exactly once` };
          }
          return {
            valid: true,
            round,
            file: parsed.file,
            hypothesis: parsed.hypothesis,
            find: parsed.find,
            replace: parsed.replace,
            detail: `edit to ${parsed.file} shaped: ${parsed.hypothesis.slice(0, 120)}`,
          };
        },
      });

      const trialTool = tool({
        name: 'run_trials',
        description: 'Run control and variant arms as dry subprocess runs and compare.',
        parameters: z.object({ shape_result: z.unknown().optional() }),
        timeoutMs: 3_600_000,
        execute: async ({ shape_result }) => {
          const shaped = shape_result as { valid?: boolean; file?: string; find?: string; replace?: string } | undefined;
          if (shaped?.valid !== true || shaped.file === undefined) {
            return { compared: false, detail: 'nothing shaped to trial' };
          }

          // Both arms run from clones of the same committed base, so
          // they cannot differ by uncommitted working-tree edits — only
          // by the patch. A clone is HEAD, and check_proposal validated
          // against the working tree, so the find-text is re-verified
          // in the clone: a silent String.replace no-op would measure
          // two identical arms and report an honest-looking null.
          const cloneAt = await mkdtemp(join(tmpdir(), 'cycgraph-tune-'));
          const cloneArm = async (name: string): Promise<string> => {
            const root = join(cloneAt, name);
            await exec('git', ['clone', '--quiet', '--no-hardlinks', '--', repoRoot, root]);
            if (!existsSync(join(root, 'node_modules'))) {
              await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
            }
            return root;
          };
          const controlRoot = await cloneArm('control');
          const variantRoot = await cloneArm('variant');
          const editAt = resolveSourcePath(variantRoot, sourceDir, shaped.file);
          if (editAt === undefined) {
            await rm(cloneAt, { recursive: true, force: true });
            return { compared: false, detail: `'${shaped.file}' resolves outside ${sourceDir}/ — refusing to edit the clone` };
          }
          const original = await readFile(editAt, 'utf8');
          const occurrences = original.split(shaped.find!).length - 1;
          if (occurrences !== 1) {
            await rm(cloneAt, { recursive: true, force: true });
            return {
              compared: false,
              detail: `the find-text appears ${occurrences} time(s) at HEAD — it was validated against the working tree; commit or restate the proposal against committed source`,
            };
          }
          await writeFile(editAt, original.replace(shaped.find!, shaped.replace!));

          const arm = async (root: string): Promise<ArmResult> => {
            const result: ArmResult = { runs: 0, completed: 0, gatePassed: 0, avgTokens: 0, costUsd: 0 };
            let tokens = 0;
            let yieldSum = 0;
            let sawYield = false;
            for (let i = 0; i < p.trials; i++) {
              const resultAt = join(cloneAt, `result-${randomUUID().slice(0, 8)}.json`);
              try {
                await exec('npx', ['tsx', join(root, 'ops/maintenance/src/run.ts'), p.target, ...TUNABLE[p.target]!, '--repoRoot', repoRoot],
                  {
                    cwd: root,
                    maxBuffer: 64 * 1024 * 1024,
                    timeout: 1_500_000,
                    // No DB: trials must not pollute the corpus, and the
                    // arms must not differ by lesson injection. A trial
                    // is the maintenance process itself, so it keeps the
                    // run's credentials that `checksEnv` scrubs from
                    // workspace commands — without them every arm crashes.
                    env: { ...checksEnv(), ...maintenanceSecrets(), MAINTAIN_RESULT_JSON: resultAt },
                  });
              } catch {
                // A crashed trial counts as a run that did not complete.
              }
              result.runs += 1;
              try {
                const parsed = MaintainResultSchema.parse(JSON.parse(await readFile(resultAt, 'utf8')));
                if (parsed.status === 'completed') result.completed += 1;
                if (parsed.gate === true) result.gatePassed += 1;
                tokens += parsed.tokens;
                result.costUsd += parsed.cost_usd;
                if (parsed.yield !== undefined) { yieldSum += parsed.yield; sawYield = true; }
              } catch {
                // No result file: the subprocess died before reporting.
              }
            }
            result.avgTokens = result.runs === 0 ? 0 : Math.round(tokens / result.runs);
            if (sawYield) result.yield = yieldSum;
            return result;
          };

          try {
            // Interleaving would be fairer under drifting external state;
            // arms run whole for simplicity, control first.
            const control = await arm(controlRoot);
            const variant = await arm(variantRoot);
            const verdict = variantWins(control, variant);
            return {
              compared: true,
              control,
              variant,
              wins: verdict.wins,
              cost_only: verdict.costOnly === true,
              detail: verdict.detail,
              table: [
                `| arm | runs | completed | gate passed | output | avg tokens | cost |`,
                `| --- | --- | --- | --- | --- | --- | --- |`,
                `| control | ${control.runs} | ${control.completed} | ${control.gatePassed} | ${control.yield ?? '—'} | ${control.avgTokens} | $${control.costUsd.toFixed(2)} |`,
                `| variant | ${variant.runs} | ${variant.completed} | ${variant.gatePassed} | ${variant.yield ?? '—'} | ${variant.avgTokens} | $${variant.costUsd.toFixed(2)} |`,
              ].join('\n'),
            };
          } finally {
            await rm(cloneAt, { recursive: true, force: true });
          }
        },
      });

      const ticketTool = tool({
        name: 'file_ticket',
        description: 'File the winning proposal as a marker-keyed, deduped ticket.',
        parameters: z.object({ shape_result: z.unknown().optional(), trial_result: z.unknown().optional() }),
        timeoutMs: 120_000,
        execute: async ({ shape_result, trial_result }) => {
          const shaped = shape_result as { hypothesis?: string; file?: string; find?: string; replace?: string } | undefined;
          const trial = trial_result as { table?: string; detail?: string; cost_only?: boolean } | undefined;
          const costOnly = trial?.cost_only === true;
          if (shaped?.file === undefined) return { filed: false, detail: 'nothing to file' };
          const key = tuneKey(p.target, { file: shaped.file, replace: shaped.replace ?? '' });
          if (!p.file) return { filed: false, key, detail: 'dry run' };

          const issues = await listOpenIssues(repoRoot, token !== undefined ? { token } : {});
          if (issues === undefined) {
            return { filed: false, key, detail: 'cannot read the issue ledger — refusing to file blind' };
          }
          if (issueMarkers(issues).has(key)) {
            return { filed: false, key, detail: 'an open ticket already carries this proposal' };
          }
          const outcome = await createIssue(repoRoot, {
            title: `[tune]${costOnly ? ' cost-win' : ''} ${p.target}: ${(shaped.hypothesis ?? '').slice(0, 80)}`,
            body: renderTuneTicket({
              target: p.target,
              hypothesis: shaped.hypothesis ?? '',
              trials: p.trials,
              trialDetail: trial?.detail ?? '',
              trialTable: trial?.table ?? '',
              file: shaped.file,
              find: shaped.find ?? '',
              replace: shaped.replace ?? '',
              costOnly,
              marker: findingMarker(key),
            }),
          }, token !== undefined ? { token } : {});
          return 'url' in outcome
            ? { filed: true, key, url: outcome.url, detail: `filed ${outcome.url}` }
            : { filed: false, key, detail: `could not file: ${outcome.error}` };
        },
      });

      const analyst = agent({
        id: 'tune-analyst',
        name: 'Tune analyst',
        model: env.model,
        provider: env.provider,
        temperature: 0.3,
        maxSteps: 20,
        instructions: p.prompt !== '' ? p.prompt : [
          'You study one maintenance workflow\'s measured failures and propose exactly one edit to its agent instructions or configuration that would plausibly move the numbers.',
          'The scorecard and recent failures are in your instructions. Use search and read_file to find the source file and the exact instruction text implicated — quote it character for character.',
          'Prefer the smallest edit with a mechanism: a clarified output contract, a step-budget rule, a sharpened refusal. Never weaken a gate, a guard, or a security check — proposals that loosen verification will be refused by the human.',
          'If a prior attempt\'s shape failure is in your context, fix exactly what it names.',
          'Reply with exactly this shape:',
          'HYPOTHESIS: <one sentence: the failure mechanism and why this edit helps>',
          'FILE: <repo-relative path under ops/maintenance/src/>',
          'FIND:',
          '<<<',
          '<the exact current text, verbatim, unique in the file>',
          '>>>',
          'REPLACE:',
          '<<<',
          '<the new text>',
          '>>>',
        ].join('\n'),
        tools: [hands.search, hands.read],
      });

      const sense = node({ id: 'sense', type: 'tool', toolId: 'sense_target', tools: [senseTool], reads: [] });
      const propose = node({
        id: 'propose',
        agent: analyst,
        failurePolicy: { timeoutMs: 900_000 },
        reads: [sense.result, 'shape_result'],
        writes: 'proposal',
        // The shared pool: nothing writes wf:tune (no reflection tail
        // here), and cross-workflow lessons are the relevant ones.
        ...(env.memory ? { memoryQuery: { tags: ['lesson'], maxFacts: 6 } } : {}),
      });
      const shape = node({ id: 'shape', type: 'tool', toolId: 'check_proposal', tools: [shapeTool], reads: ['proposal', 'shape_result'] });
      const shaped = verifier.expression(
        `memory.${shape.result}.valid`,
        { id: 'shaped', reads: [shape.result], description: 'The proposal names a real file and quotes text that exists exactly once' },
      );
      const trial = node({ id: 'trial', type: 'tool', toolId: 'run_trials', tools: [trialTool], reads: [shape.result] });
      const won = verifier.expression(
        `memory.${trial.result}.wins`,
        { id: 'won', reads: [trial.result], description: 'The variant arm measurably beat control' },
      );
      const ticket = node({ id: 'ticket', type: 'tool', toolId: 'file_ticket', tools: [ticketTool], reads: [shape.result, trial.result] });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'tune',
          description: 'Sense a workflow\'s failures, propose a source edit, trial it, ticket a winner.',
          nodes: [sense, propose, shape, shaped, trial, won, ticket, report],
          edges: [
            { from: sense, to: propose, when: `memory.${sense.result}.has_signal` },
            { from: sense, to: report, when: `not memory.${sense.result}.has_signal` },
            { from: propose, to: shape },
            { from: shape, to: shaped },
            { from: shaped, to: trial, when: 'memory.shaped_verification_passed' },
            {
              from: shaped,
              to: propose,
              when: `not memory.shaped_verification_passed and memory.${shape.result}.round < ${p.attempts}`,
            },
            // Never shaping a valid proposal is a clean no-proposal exit.
            {
              from: shaped,
              to: report,
              when: `not memory.shaped_verification_passed and memory.${shape.result}.round >= ${p.attempts}`,
            },
            { from: trial, to: won },
            { from: won, to: ticket, when: 'memory.won_verification_passed' },
            // A losing variant ends cleanly: the measurement was the work.
            { from: won, to: report, when: 'not memory.won_verification_passed' },
            { from: ticket, to: report },
          ],
          startNode: sense,
          endNodes: [report],
        }),
        input: {
          goal: `Propose one measured improvement to ${p.target}.`,
          maxIterations: 6 + p.attempts * 3,
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
        },
        runner: {},
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'sense_result' },
    ],
  };
}

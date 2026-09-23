/**
 * The tune proposal and ticket formats, and the trial comparison.
 *
 * The pure surface of the tune loop: the subprocess result schema the
 * trials read, the tunable-target table, the analyst's proposal parser,
 * the ticket render/parse round-trip, path containment for the proposed
 * edit, and the win decision over the two trial arms. Everything here is
 * pure (or schema) so it can be pinned by tests, and it is imported by
 * implement-ticket (to apply a tune ticket) and run.ts (the result schema).
 *
 * @module maintenance/tune/proposal
 */

import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { APPROVED_LABEL } from '../shared/repo.js';

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
  'fix-repo-docs': ['--commit', 'true', '--publish', 'false', '--batch', '3', '--budgetTokens', '1200000'],
  'fix-website-docs': ['--commit', 'true', '--publish', 'false', '--batch', '3', '--budgetTokens', '1200000'],
  'repo-audit': ['--file', 'false', '--maxAuditors', '2', '--steps', '16', '--budgetTokens', '600000'],
  'feature-propose': ['--file', 'false'],
};

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
  const hypothesis = /^HYPOTHESIS:(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const file = /^FILE:(.*)$/m.exec(text)?.[1]?.trim() ?? '';
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
    `Approve with the \`${APPROVED_LABEL}\` label; implement-ticket applies it as any other approved ticket.`,
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

/**
 * The shape a feature proposal must hold, and its parser.
 *
 * A feature's only honest fitness signal is a human merging it, so the
 * machine's job before the human is structural: a proposal without a
 * motivation, a design sketch, evidence from the codebase, and at least
 * one mechanically checkable acceptance criterion is not reviewable and
 * is refused before it can become a ticket. Everything here is pure so
 * the gate's judgement can be pinned by tests.
 *
 * @module maintenance/proposal
 */

import { keySlug, legacyKeySlug } from './key-slug.js';

/** A parsed proposal; `missing` names whatever the text failed to carry. */
export interface FeatureProposal {
  title: string;
  motivation: string;
  design: string;
  evidence: string;
  /** Acceptance bullet lines — what "done" means, mechanically. */
  acceptance: string[];
  missing: string[];
}

const SECTIONS = ['MOTIVATION', 'DESIGN', 'EVIDENCE', 'ACCEPTANCE'] as const;

/**
 * Parse the line-oriented proposal format the proposer agent is told to
 * emit. Tolerant of a capable model's instinct to typeset: headers
 * survive markdown emphasis and heading marks (`**MOTIVATION:**`,
 * `## DESIGN`), and acceptance bullets may be dashed, starred, or
 * numbered.
 */
export function parseProposal(text: string): FeatureProposal {
  const title = text.match(/^[#*\s]*TITLE:\s*(.+)$/m)?.[1]
    ?.trim().replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim() ?? '';

  const sections: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const header = line.match(/^[#*\s]*([A-Z]+):?[*\s]*$/)?.[1];
    if (header !== undefined && (SECTIONS as readonly string[]).includes(header)) {
      current = header;
      sections[current] = [];
      continue;
    }
    if (/^[#*\s]*TITLE:/.test(line)) { current = undefined; continue; }
    if (current !== undefined) sections[current]!.push(line);
  }

  const body = (name: string) => (sections[name] ?? []).join('\n').trim();
  const acceptance = (sections['ACCEPTANCE'] ?? [])
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)?.[1] ?? '')
    .filter((line) => line.length > 0);

  const missing: string[] = [];
  if (title === '') missing.push('TITLE');
  for (const name of ['MOTIVATION', 'DESIGN', 'EVIDENCE']) {
    if (body(name) === '') missing.push(name);
  }
  if (acceptance.length === 0) missing.push('ACCEPTANCE');

  return {
    title,
    motivation: body('MOTIVATION'),
    design: body('DESIGN'),
    evidence: body('EVIDENCE'),
    acceptance,
    missing,
  };
}

/** The ledger key a proposal dedupes on: its normalized title (see {@link keySlug}). */
export function proposalKey(title: string): string {
  return `feature:${keySlug(title)}`;
}

/**
 * The key a proposal with this title was filed under before keys
 * carried a digest (see {@link legacyKeySlug}). Dedupe reads it so an
 * open long-titled proposal is not re-filed; nothing writes it.
 */
export function legacyProposalKey(title: string): string {
  return `feature:${legacyKeySlug(title)}`;
}

/** Repository-path-shaped tokens in a text, for evidence verification. */
export function pathTokens(text: string): string[] {
  return [...new Set((text.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g) ?? [])
    .map((token) => token.replace(/[.,;:)]+$/, '')))];
}

/**
 * Command shapes an acceptance criterion may execute. An issue body is
 * only semi-trusted — its author can edit it after approval — so a
 * runnable criterion must invoke the repository's own scripts and
 * checkers, never arbitrary programs or arguments. What these reject is
 * still a criterion; it just waits for the human PR review instead.
 *
 * These are this repository's own Node shapes. The allowlist is not a
 * product concern: the product treats the repository's CI as the
 * authoritative gate and runs no tree code locally, so this gates only
 * customer-zero's local checks, which run against this Node repository.
 */
const SAFE_COMMANDS = [
  /^npm test$/,
  /^npm run [A-Za-z0-9:._-]+(?: --workspace=[A-Za-z0-9@/._-]+)?$/,
  /^npx vitest run(?: [A-Za-z0-9/._-]+)?$/,
  /^npx tsc --noEmit$/,
];

/** The runnable command inside an acceptance bullet, or `undefined`. */
export function safeAcceptanceCommand(bullet: string): string | undefined {
  const backticked = bullet.match(/`([^`]+)`/)?.[1] ?? bullet;
  const command = backticked.trim();
  return SAFE_COMMANDS.some((shape) => shape.test(command)) ? command : undefined;
}

/**
 * Run a ticket's acceptance commands, returning those that failed. Each
 * command is re-validated through {@link safeAcceptanceCommand} at the
 * point of execution: the list reaches here as a model-relayed tool
 * argument, so a command that does not match an allowed repository-script
 * shape is refused and counted as a failure rather than run. The `run`
 * callback executes one validated command and throws on non-zero exit.
 */
export async function runAcceptanceCommands(
  commands: readonly string[],
  run: (safeCommand: string) => Promise<void>,
): Promise<{ command: string; output: string }[]> {
  const failed: { command: string; output: string }[] = [];
  for (const command of commands) {
    const safe = safeAcceptanceCommand(command);
    if (safe === undefined) {
      failed.push({ command, output: `refused: '${command}' is not an allowed repository check shape` });
      continue;
    }
    try {
      await run(safe);
    } catch (error) {
      failed.push({
        command,
        output: String((error as { stdout?: string; stderr?: string }).stdout
          ?? (error as { stderr?: string }).stderr ?? (error as Error).message).slice(-2_000),
      });
    }
  }
  return failed;
}

/** The verified diff an optimization ticket carries in its fenced block. */
export function extractTicketDiff(body: string): string | undefined {
  const match = body.match(/```diff\n([\s\S]*?)```/);
  const diff = match?.[1];
  if (diff === undefined || diff.includes('… (truncated)')) return undefined;
  return diff;
}

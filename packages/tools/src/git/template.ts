/**
 * Pull-request bodies that follow the target repository's template.
 *
 * A maintenance PR should read like a contributor's PR, and the fill
 * stays honest: prose sections are written from run evidence, a
 * checkbox is ticked only when the caller supplies the evidence for it
 * (each tick carries its note), template blocks the diff makes
 * inapplicable say so explicitly, and anything the run cannot vouch
 * for is left for the human who merges. A repository without a
 * template gets the same evidence as a plain body.
 *
 * @module git/template
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One checkbox the delivering run can speak to. */
export interface PrCheckTick {
  /** Substring identifying the checkbox line in the template. */
  match: string;
  /** Short evidence appended to the line. */
  note?: string;
  /** False annotates the line without ticking it (the run looked, but cannot vouch). */
  checked?: boolean;
}

/** What a workflow can honestly say about the change it delivers. */
export interface PrEvidence {
  /** One-paragraph statement of what the PR does and why. */
  summary: string;
  /** Bullet lines for the template's changes section. */
  changes?: string[];
  /** Where the change came from: workflow name, run id, verdict. */
  provenance?: string;
  /** Issue numbers this PR closes; fills the template's Related issues section. */
  closes?: number[];
  /** Checkboxes the run's own facts justify ticking or annotating. */
  ticks?: PrCheckTick[];
  /** Template blocks the diff makes inapplicable, each with the reason. */
  notApplicable?: { heading: string; reason: string }[];
}

/**
 * Replace the content under one `## Heading` with `content`, leaving
 * every other section byte-identical. A heading the body lacks leaves
 * the body unchanged.
 */
export function fillSection(body: string, heading: string, content: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) { end = i; break; }
  }
  return [...lines.slice(0, start + 1), '', content, '', ...lines.slice(end)].join('\n');
}

/**
 * Tick (or merely annotate) the first unchecked `- [ ]` line containing
 * `match`, appending the note as inline evidence. A body without a
 * matching line is returned unchanged, so ticks written against one
 * template survive template drift as no-ops rather than corruption.
 */
export function tickCheckbox(body: string, tick: PrCheckTick): string {
  const lines = body.split('\n');
  const index = lines.findIndex((line) => /^\s*- \[ \]/.test(line) && line.includes(tick.match));
  if (index === -1) return body;
  let line = lines[index]!;
  if (tick.checked !== false) line = line.replace('- [ ]', '- [x]');
  if (tick.note !== undefined && tick.note !== '') line = `${line} — ${tick.note}`;
  lines[index] = line;
  return lines.join('\n');
}

/**
 * Build a PR body from evidence, following the repository's
 * `.github/PULL_REQUEST_TEMPLATE.md` when it has one.
 *
 * With a template: Summary and Changes are filled, evidenced ticks
 * land on their checkbox lines, inapplicable blocks are replaced with
 * the reason, closed issues fill the Related issues section, and
 * provenance is appended as its own section; everything the run cannot
 * vouch for is preserved as written. Without a template, the evidence
 * renders as a plain body in the same order.
 */
export async function prBodyFor(repoRoot: string, evidence: PrEvidence): Promise<string> {
  const template = await readFile(
    join(repoRoot, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8',
  ).catch(() => undefined);

  const changeLines = (evidence.changes ?? []).map((change) => `- ${change}`).join('\n');
  const closesLines = (evidence.closes ?? []).map((issue) => `Closes #${issue}`).join('\n');
  const provenance = evidence.provenance !== undefined
    ? `## Provenance\n\n${evidence.provenance}`
    : undefined;

  if (template === undefined) {
    return [
      evidence.summary,
      ...(changeLines.length > 0 ? [`## Changes\n\n${changeLines}`] : []),
      ...(closesLines.length > 0 ? [closesLines] : []),
      ...(provenance !== undefined ? [provenance] : []),
    ].join('\n\n');
  }

  let body = fillSection(template, 'Summary', evidence.summary);
  if (changeLines.length > 0) body = fillSection(body, 'Changes', changeLines);
  for (const section of evidence.notApplicable ?? []) {
    body = fillSection(body, section.heading, `_Not applicable — ${section.reason}._`);
  }
  for (const tick of evidence.ticks ?? []) body = tickCheckbox(body, tick);
  if (closesLines.length > 0) body = fillSection(body, 'Related issues', closesLines);
  if (provenance !== undefined) body = `${body.trimEnd()}\n\n${provenance}\n`;
  return body;
}

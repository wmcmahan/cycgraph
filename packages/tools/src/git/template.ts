/**
 * Pull-request bodies that follow the target repository's template.
 *
 * A maintenance PR should read like a contributor's PR. The honest fill
 * for a template is partial: the prose sections a machine can state —
 * summary, the list of changes — are written from run evidence, and the
 * checklists are left untouched for the human who merges. A repository
 * without a template gets the same evidence as a plain body.
 *
 * @module git/template
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What a workflow can honestly say about the change it delivers. */
export interface PrEvidence {
  /** One-paragraph statement of what the PR does and why. */
  summary: string;
  /** Bullet lines for the template's changes section. */
  changes?: string[];
  /** Where the change came from: workflow name, run id, verdict. */
  provenance?: string;
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
 * Build a PR body from evidence, following the repository's
 * `.github/PULL_REQUEST_TEMPLATE.md` when it has one.
 *
 * With a template: the Summary and Changes sections are filled, the
 * rest — checklists included — is preserved as written, and provenance
 * is appended as its own section. Without one, the evidence renders as
 * a plain body in the same order.
 */
export async function prBodyFor(repoRoot: string, evidence: PrEvidence): Promise<string> {
  const template = await readFile(
    join(repoRoot, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8',
  ).catch(() => undefined);

  const changeLines = (evidence.changes ?? []).map((change) => `- ${change}`).join('\n');
  const provenance = evidence.provenance !== undefined
    ? `## Provenance\n\n${evidence.provenance}`
    : undefined;

  if (template === undefined) {
    return [
      evidence.summary,
      ...(changeLines.length > 0 ? [`## Changes\n\n${changeLines}`] : []),
      ...(provenance !== undefined ? [provenance] : []),
    ].join('\n\n');
  }

  let body = fillSection(template, 'Summary', evidence.summary);
  if (changeLines.length > 0) body = fillSection(body, 'Changes', changeLines);
  if (provenance !== undefined) body = `${body.trimEnd()}\n\n${provenance}\n`;
  return body;
}

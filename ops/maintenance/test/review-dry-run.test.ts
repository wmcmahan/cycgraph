/**
 * The review workflows' dry runs: the real post_review and push_revision
 * tools, run with posting off against a scratch git repository, return a
 * preview of everything they would post, built by the posting code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import { defaultMaintenanceContext } from '../src/shared/context.js';
import { maintenanceEnvFromProcess } from '../src/shared/env.js';
import { prReview } from '../src/pr-review/index.js';
import { prRevise } from '../src/pr-revise/index.js';
import { postReviewTool } from '../src/pr-review/tools/post-review.js';
import { pushRevisionTool } from '../src/pr-revise/tools/push-revision.js';
import type { ReviewContext } from '../src/pr-review/context.js';
import type { ReviseContext } from '../src/pr-revise/context.js';

const UNREACHABLE_REPO = '/nonexistent/cycgraph-dry-run';
const RUN_ID = '0f8e2c1a-4b7d-4e2a-9c3f-1d2e3f4a5b6c';
const CHANGED_LINE = 15;

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
}

function lines(changed: boolean): string {
  return Array.from({ length: 20 }, (_, i) => (changed && i + 1 === CHANGED_LINE ? 'export const env = () => process.env;' : `export const v${i + 1} = ${i + 1};`)).join('\n');
}

function env() {
  return { ...maintenanceEnvFromProcess({ CYCGRAPH_MODEL: 'claude-opus-5-5' }), provenance: { runId: RUN_ID } };
}

function titlesOf(preview: string): string[] {
  return [...preview.matchAll(/^── (.*)$/gm)].map((match) => match[1]!);
}

function sectionOf(preview: string, title: string): string {
  const start = preview.indexOf(`── ${title}\n`) + `── ${title}\n`.length;
  const end = preview.indexOf('\n\n── ', start);
  return preview.slice(start, end === -1 ? undefined : end);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cycgraph-dry-run-'));
  git('init', '--quiet');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), lines(false));
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  git('update-ref', 'refs/pr-review/base', 'HEAD');
  writeFileSync(join(repo, 'src/a.ts'), lines(true));
  git('commit', '--quiet', '-am', 'change');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('postReviewTool', () => {
  function reviewContext(): ReviewContext {
    return {
      params: prReview().params.parse({ pr: 1, comment: false }),
      env: env(),
      repoRoot: UNREACHABLE_REPO,
      maintenance: defaultMaintenanceContext(),
      standardsBrief: 'brief',
      workspaceAt: repo,
      session: createWorkspaceSession(),
      token: undefined,
    };
  }

  const REVIEW = [
    'VERDICT: REVISE',
    'The helper is duplicated, one constant is dead, and the changelog is missing.',
    'T1: ADDRESSED — the cast is narrowed now',
    'P1: UNRESOLVED — still no entry',
    `1. src/a.ts:${CHANGED_LINE} — duplicates ghEnv — reuse the existing helper`,
    '   ghEnv already lives at src/git/pr.ts:120',
    '2. src/a.ts:1 — v1 is never read — delete it',
    '3. The PR description omits the migration — document it',
  ].join('\n');

  const GATHERED = {
    labels: ['maintenance-managed'],
    advisory_rounds: 1,
    resolvable_threads: [{ label: 'T1', thread_id: 'PRRT_1', comment_id: 5 }],
    prior_findings: [{ label: 'P1', text: 'The changelog is missing — add one' }],
  };

  it('previews every post in order without posting', async () => {
    const result = await postReviewTool(reviewContext()).execute({
      review: REVIEW,
      verdict_result: { approved: false, detail: 'requested changes: 3 finding(s)' },
      gather_result: GATHERED,
    }) as { posted: boolean; preview: string };

    expect(result.posted).toBe(false);
    expect(titlesOf(result.preview)).toEqual([
      'file comment · src/a.ts',
      `line comment · src/a.ts:${CHANGED_LINE}`,
      'review (COMMENT)',
      'reply in T1, then resolve it',
    ]);
  });

  it('previews the review body as it would be posted', async () => {
    const result = await postReviewTool(reviewContext()).execute({
      review: REVIEW,
      verdict_result: { approved: false, detail: 'requested changes' },
      gather_result: GATHERED,
    }) as { preview: string };
    const head = git('rev-parse', 'HEAD');

    expect(sectionOf(result.preview, 'review (COMMENT)')).toBe([
      `<!-- cycgraph:pr-review run=${RUN_ID} commit=${head} model=claude-opus-5-5 -->`,
      'Advisory review by the pr-review workflow — the human merge decision stands either way.',
      '',
      'VERDICT: REVISE',
      'The helper is duplicated, one constant is dead, and the changelog is missing.',
      '',
      '**Overall**',
      '- The PR description omits the migration — document it',
      '- Still open from the last review: The changelog is missing — add one',
      '  - still no entry',
      '',
      '2 findings are posted as comments on the diff.',
      'Earlier threads: 1 addressed, 0 still open. Each judgment is a reply in its thread.',
      '',
      '@cycgraph please address the open review threads and any findings above.',
      '',
      `<sub>Reviewed at \`${head.slice(0, 7)}\` · with claude-opus-5-5</sub>`,
    ].join('\n'));
  });

  it('notes on the PR that unreadable earlier threads were left alone', async () => {
    const result = await postReviewTool(reviewContext()).execute({
      review: 'VERDICT: REVISE\nOne problem.\n3. The PR description omits the migration — document it',
      verdict_result: { approved: false, detail: 'requested changes' },
      gather_result: { ...GATHERED, resolvable_threads: [], threads_unreadable: true },
    }) as { preview: string };

    expect(sectionOf(result.preview, 'review (COMMENT)')).toContain(
      'The earlier review threads could not be read, so they were not judged and are left as they were.',
    );
    expect(titlesOf(result.preview)).toEqual(['review (COMMENT)']);
  });

  it('previews a file comment with the line named in its text', async () => {
    const result = await postReviewTool(reviewContext()).execute({
      review: REVIEW,
      verdict_result: { approved: false, detail: 'requested changes' },
      gather_result: GATHERED,
    }) as { preview: string };

    expect(sectionOf(result.preview, 'file comment · src/a.ts').split('\n').slice(1)).toEqual(['Line 1: v1 is never read — delete it']);
  });

  it('previews the label and trace for an inconclusive review without applying them', async () => {
    const result = await postReviewTool(reviewContext()).execute({
      review: 'no verdict here',
      verdict_result: { malformed: true, detail: 'no VERDICT marker' },
      gather_result: GATHERED,
    }) as { posted: boolean; needs_human: boolean; preview: string };

    expect(result.posted).toBe(false);
    expect(result.needs_human).toBe(true);
    expect(titlesOf(result.preview)).toEqual(['label', 'conversation comment']);
    expect(sectionOf(result.preview, 'label')).toBe('add needs-human');
  });
});

describe('pushRevisionTool', () => {
  function reviseContext(): ReviseContext {
    return {
      params: prRevise().params.parse({ pr: 1, push: false }),
      env: env(),
      repoRoot: UNREACHABLE_REPO,
      maintenance: defaultMaintenanceContext(),
      standardsBrief: 'brief',
      workspaceAt: repo,
      session: createWorkspaceSession(),
      token: undefined,
    };
  }

  const GATHERED = {
    head: 'feature',
    reply_targets: [{ label: 'T1', id: 5 }],
    top_level_items: [{ label: 'C1', excerpt: 'the review summary' }],
  };

  it('previews the workspace, diff, thread replies, and summary without pushing', async () => {
    writeFileSync(join(repo, 'src/a.ts'), lines(false));

    const result = await pushRevisionTool(reviseContext()).execute({
      gather_result: GATHERED,
      revise_report: 'Reused ghEnv.\nREPLY T1: now imports ghEnv\nREPLY C1: documented the migration',
    }) as { pushed: boolean; preview: string };

    expect(result.pushed).toBe(false);
    expect(titlesOf(result.preview)).toEqual(['workspace', 'diff (1 file(s))', 'reply in T1', 'conversation comment']);
    expect(sectionOf(result.preview, 'reply in T1')).toBe(
      `<!-- cycgraph:pr-reply run=${RUN_ID} model=claude-opus-5-5 -->\nnow imports ghEnv`,
    );
    expect(sectionOf(result.preview, 'conversation comment')).toContain('- **Re: the review summary** documented the migration');
  });

  it('leaves the change uncommitted in the workspace', async () => {
    writeFileSync(join(repo, 'src/a.ts'), lines(false));
    const before = git('rev-parse', 'HEAD');

    await pushRevisionTool(reviseContext()).execute({ gather_result: GATHERED, revise_report: 'Done.' });

    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(git('status', '--porcelain')).toBe('M src/a.ts');
  });
});

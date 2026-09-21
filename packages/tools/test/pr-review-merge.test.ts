/**
 * Tests for the degradation logic in src/git/pr.ts: the retry and
 * fallback chain in `submitPrReview`, the pending-review cleanup it
 * runs per attempt, `enableAutoMerge`'s direct-merge fallback,
 * `setPrLabels`' failure aggregation, and the review-thread reads.
 *
 * Every `gh` invocation is scripted through a mocked `execFile`, so the
 * success and degradation branches run without an authenticated CLI:
 * no process is spawned and no network is touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

interface GhCall {
  command: string;
  args: string[];
}

type GhOutcome = { stdout: string } | { throws: unknown };

type GhHandler = (call: GhCall) => GhOutcome | Promise<GhOutcome>;

let calls: GhCall[] = [];
let handler: GhHandler = () => ({ stdout: '' });

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (): never => {
    throw new Error('the callback form of execFile is unused');
  };
  return {
    ...actual,
    // pr.ts promisifies execFile, so the stub is the promisified form
    // node itself installs under this symbol, not a callback.
    execFile: Object.assign(execFile, {
      [promisify.custom]: async (
        command: string,
        args: readonly string[],
      ): Promise<{ stdout: string; stderr: string }> => {
        const call: GhCall = { command, args: [...args] };
        calls.push(call);
        const outcome = await handler(call);
        if ('throws' in outcome) throw outcome.throws;
        return { stdout: outcome.stdout, stderr: '' };
      },
    }),
  };
});

const {
  enableAutoMerge,
  listReviewThreads,
  resolveReviewThread,
  setPrLabels,
  submitPrReview,
} = await import('../src/git/index.js');

const PR = 12;
const REVIEWS = `repos/{owner}/{repo}/pulls/${PR}/reviews`;

/** A `gh api` failure: the reason rides stdout, as the real CLI reports it. */
const apiError = (message: string): Error =>
  Object.assign(new Error('Command failed: gh api'), {
    stdout: JSON.stringify({ message }),
    stderr: 'gh: Unprocessable Entity (HTTP 422)',
  });

/** A `gh pr` failure: no response body, the reason on stderr. */
const cliError = (stderr: string): Error =>
  Object.assign(new Error('Command failed: gh pr'), { stderr });

const isReviewPost = (call: GhCall): boolean => call.args.includes('--input');

const isReviewDelete = (call: GhCall): boolean =>
  call.args.includes('DELETE') && (call.args[1] ?? '').startsWith(REVIEWS);

const reviewPayload = async (call: GhCall): Promise<{
  event: string;
  body: string;
  comments?: { path: string; line: number; side: string; body: string }[];
}> => JSON.parse(await readFile(String(call.args[call.args.indexOf('--input') + 1]), 'utf8'));

const argsOf = (): string[][] => calls.map((call) => call.args);

beforeEach(() => {
  calls = [];
  handler = () => ({ stdout: '' });
});

describe('submitPrReview', () => {
  it('submits the requested verdict with its inline comments', async () => {
    const payloads: unknown[] = [];
    handler = async (call) => {
      if (!isReviewPost(call)) return { stdout: '[]' };
      payloads.push(await reviewPayload(call));
      return { stdout: '{}' };
    };

    const result = await submitPrReview('/repo', PR, {
      event: 'APPROVE',
      body: 'looks good',
      comments: [{ path: 'a.ts', line: 3, body: 'nit' }],
    });

    expect(result).toEqual({
      ok: true,
      event: 'APPROVE',
      inlineCount: 1,
      detail: 'submitted APPROVE review with 1 inline comment(s)',
    });
    expect(payloads).toEqual([{
      event: 'APPROVE',
      body: 'looks good',
      comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'nit' }],
    }]);
  });

  it('degrades an APPROVE the API refuses on an own pull request to a COMMENT review', async () => {
    const events: string[] = [];
    handler = async (call) => {
      if (!isReviewPost(call)) return { stdout: '[]' };
      const payload = await reviewPayload(call);
      events.push(payload.event);
      return payload.event === 'COMMENT'
        ? { stdout: '{}' }
        : { throws: apiError('Can not approve your own pull request') };
    };

    const result = await submitPrReview('/repo', PR, { event: 'APPROVE', body: 'ship it' });

    expect(result).toEqual({
      ok: true,
      event: 'COMMENT',
      inlineCount: 0,
      detail: 'submitted COMMENT review with 0 inline comment(s)'
        + ' (APPROVE refused on own PR, submitted as COMMENT)',
    });
    expect(events).toEqual(['APPROVE', 'COMMENT']);
  });

  it('drops rejected inline comments and resubmits a body-only review', async () => {
    const commentCounts: number[] = [];
    handler = async (call) => {
      if (!isReviewPost(call)) return { stdout: '[]' };
      const payload = await reviewPayload(call);
      commentCounts.push(payload.comments?.length ?? 0);
      return payload.comments === undefined
        ? { stdout: '{}' }
        : { throws: apiError('line must be part of the diff') };
    };

    const result = await submitPrReview('/repo', PR, {
      event: 'COMMENT',
      body: 'findings inline',
      comments: [{ path: 'a.ts', line: 99, body: 'out of diff' }],
    });

    expect(result).toEqual({
      ok: true,
      event: 'COMMENT',
      inlineCount: 0,
      detail: 'submitted COMMENT review with 0 inline comment(s)'
        + ' (inline comments rejected (line must be part of the diff), kept in the body)',
    });
    expect(commentCounts).toEqual([1, 0]);
  });

  it('discards a leftover pending review before submitting', async () => {
    let discarded = false;
    handler = (call) => {
      if (isReviewPost(call)) return { stdout: '{}' };
      if (isReviewDelete(call)) {
        discarded = true;
        return { stdout: '' };
      }
      return { stdout: JSON.stringify(discarded ? [] : [{ id: 7, state: 'PENDING' }]) };
    };

    const result = await submitPrReview('/repo', PR, { event: 'COMMENT', body: 'notes' });

    expect(result.detail).toBe(
      'submitted COMMENT review with 0 inline comment(s) (discarded leftover pending review 7)',
    );
    expect(calls.filter(isReviewDelete).map((call) => call.args)).toEqual([
      ['api', `${REVIEWS}/7`, '--method', 'DELETE'],
    ]);
  });

  it('deletes nothing when no review of the token is pending', async () => {
    handler = (call) => (isReviewPost(call)
      ? { stdout: '{}' }
      : { stdout: JSON.stringify([{ id: 1, state: 'COMMENTED' }]) });

    const result = await submitPrReview('/repo', PR, { event: 'COMMENT', body: 'notes' });

    expect(result.detail).toBe('submitted COMMENT review with 0 inline comment(s)');
    expect(calls.filter(isReviewDelete)).toEqual([]);
  });

  it('reports every degradation taken when the last attempt still fails', async () => {
    handler = async (call) => {
      if (!isReviewPost(call)) return { stdout: '[]' };
      const payload = await reviewPayload(call);
      if (payload.event !== 'COMMENT') {
        return { throws: apiError('Can not approve your own pull request') };
      }
      if (payload.comments !== undefined) {
        return { throws: apiError('line must be part of the diff') };
      }
      return { throws: apiError('Server Error') };
    };

    const result = await submitPrReview('/repo', PR, {
      event: 'APPROVE',
      body: 'ship it',
      comments: [{ path: 'a.ts', line: 3, body: 'nit' }],
    });

    expect(result).toEqual({
      ok: false,
      detail: 'review not submitted: Server Error (after: APPROVE refused on own PR,'
        + ' submitted as COMMENT; inline comments rejected'
        + ' (line must be part of the diff), kept in the body)',
    });
    expect(calls.filter(isReviewPost).length).toBe(3);
  });
});

describe('enableAutoMerge', () => {
  it('arms auto-merge when the repository accepts it', async () => {
    handler = () => ({ stdout: '' });

    const result = await enableAutoMerge('/repo', PR);

    expect(result).toEqual({
      ok: true,
      merged: 'auto',
      detail: 'auto-merge enabled; merges when checks pass',
    });
    expect(argsOf()).toEqual([['pr', 'merge', String(PR), '--auto', '--squash', '--delete-branch']]);
  });

  it('merges directly when arming auto-merge fails', async () => {
    handler = (call) => (call.args.includes('--auto')
      ? { throws: cliError('Pull request is in clean status') }
      : { stdout: '' });

    const result = await enableAutoMerge('/repo', PR);

    expect(result).toEqual({
      ok: true,
      merged: 'now',
      detail: 'merged directly (checks already green)',
    });
    expect(argsOf()[1]).toEqual(['pr', 'merge', String(PR), '--squash', '--delete-branch']);
  });

  it('names both reasons when neither merge succeeds', async () => {
    handler = (call) => ({
      throws: cliError(call.args.includes('--auto')
        ? 'auto-merge is not enabled for this repository'
        : 'Pull request is not mergeable'),
    });

    const result = await enableAutoMerge('/repo', PR);

    expect(result).toEqual({
      ok: false,
      detail: 'auto-merge failed (auto-merge is not enabled for this repository);'
        + ' direct merge failed (Pull request is not mergeable)',
    });
  });
});

describe('setPrLabels', () => {
  it('creates each added label before applying it and removes the rest', async () => {
    handler = () => ({ stdout: '' });

    const result = await setPrLabels('/repo', PR, { add: ['ready'], remove: ['blocked'] });

    expect(result).toEqual({ ok: true, detail: 'labels updated' });
    expect(argsOf()).toEqual([
      ['label', 'create', 'ready'],
      ['pr', 'edit', String(PR), '--add-label', 'ready'],
      ['pr', 'edit', String(PR), '--remove-label', 'blocked'],
    ]);
  });

  it('aggregates every label that failed to stick', async () => {
    handler = (call) => {
      const label = call.args[call.args.indexOf('--add-label') + 1];
      return call.args.includes('--add-label')
        ? { throws: cliError(`${label} is not a known label`) }
        : { stdout: '' };
    };

    const result = await setPrLabels('/repo', PR, { add: ['ready', 'urgent'] });

    expect(result).toEqual({
      ok: false,
      detail: 'add ready: ready is not a known label; add urgent: urgent is not a known label',
    });
  });

  it('treats removing an absent label as a no-op', async () => {
    handler = (call) => (call.args.includes('--remove-label')
      ? { throws: cliError('label blocked not found on this pull request') }
      : { stdout: '' });

    const result = await setPrLabels('/repo', PR, { remove: ['blocked'] });

    expect(result).toEqual({ ok: true, detail: 'labels updated' });
  });
});

describe('listReviewThreads', () => {
  const THREADS = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{
              id: 'PRRT_1',
              isResolved: false,
              path: 'src/a.ts',
              comments: {
                nodes: [{
                  body: 'finding one',
                  databaseId: 501,
                  viewerDidAuthor: true,
                  createdAt: '2026-01-02T03:04:05Z',
                  pullRequestReview: { id: 'PRR_9' },
                }],
              },
            }, {
              id: 'PRRT_2',
              isResolved: true,
              path: null,
              comments: { nodes: [] },
            }],
          },
        },
      },
    },
  };

  it('maps each thread with its resolution state and first comment', async () => {
    handler = (call) => ({
      stdout: call.args[0] === 'repo'
        ? JSON.stringify({ owner: { login: 'acme' }, name: 'widgets' })
        : JSON.stringify(THREADS),
    });

    const threads = await listReviewThreads('/repo', PR);

    expect(threads).toEqual([{
      id: 'PRRT_1',
      isResolved: false,
      path: 'src/a.ts',
      body: 'finding one',
      viewerDidAuthor: true,
      commentId: 501,
      reviewId: 'PRR_9',
      createdAt: '2026-01-02T03:04:05Z',
    }, {
      id: 'PRRT_2',
      isResolved: true,
      body: '',
      viewerDidAuthor: false,
    }]);
  });

  it('cannot see threads when the repository slug is unreadable', async () => {
    handler = () => ({ throws: cliError('no git remote found') });

    const threads = await listReviewThreads('/repo', PR);

    expect(threads).toBeUndefined();
    expect(argsOf()).toEqual([['repo', 'view', '--json', 'owner,name']]);
  });
});

describe('resolveReviewThread', () => {
  it('marks the named thread resolved', async () => {
    handler = () => ({ stdout: '{}' });

    const result = await resolveReviewThread('/repo', 'PRRT_1');

    expect(result).toEqual({ ok: true, detail: 'resolved thread PRRT_1' });
  });

  it('reports the API reason when resolution fails', async () => {
    handler = () => ({ throws: apiError('Could not resolve to a node with the global id') });

    const result = await resolveReviewThread('/repo', 'PRRT_1');

    expect(result).toEqual({
      ok: false,
      detail: 'Could not resolve to a node with the global id',
    });
  });
});

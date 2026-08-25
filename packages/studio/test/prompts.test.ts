/**
 * Tests for the dashboard's pending-prompt registry (src/server/prompts.ts),
 * which turns an approval gate into a question the page can answer.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { askHuman, answerPrompt, cancel, isWaiting } from '../src/server/prompts.js';

const RUN = 'run-1';

afterEach(() => {
  cancel(RUN, 'test cleanup');
  vi.useRealTimers();
});

describe('askHuman', () => {
  it('notifies the page with the question', async () => {
    const seen: string[] = [];

    const pending = askHuman(RUN, 'Ship it?', (q) => seen.push(q));
    answerPrompt(RUN, { decision: 'approved' });
    await pending;

    expect(seen).toEqual(['Ship it?']);
  });

  it('resolves with the answer the page sent', async () => {
    const pending = askHuman(RUN, 'Ship it?', () => {});
    answerPrompt(RUN, { decision: 'edited', data: 'tighten the intro' });

    await expect(pending).resolves.toEqual({ decision: 'edited', data: 'tighten the intro' });
  });

  it('reports the run as waiting until it is answered', async () => {
    const pending = askHuman(RUN, 'Ship it?', () => {});

    expect(isWaiting(RUN)).toBe(true);

    answerPrompt(RUN, { decision: 'approved' });
    await pending;

    expect(isWaiting(RUN)).toBe(false);
  });

  it('supersedes an earlier unanswered question from the same run', async () => {
    const first = askHuman(RUN, 'First?', () => {});
    const second = askHuman(RUN, 'Second?', () => {});
    answerPrompt(RUN, { decision: 'approved' });

    await expect(first).resolves.toMatchObject({ decision: 'rejected' });
    await expect(second).resolves.toMatchObject({ decision: 'approved' });
  });

  it('rejects rather than hanging when nobody answers', async () => {
    vi.useFakeTimers();
    const pending = askHuman(RUN, 'Ship it?', () => {});

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await expect(pending).resolves.toMatchObject({ decision: 'rejected' });
  });
});

describe('answerPrompt', () => {
  it('reports an answer nobody was waiting for', () => {
    expect(answerPrompt('never-asked', { decision: 'approved' })).toBe(false);
  });

  it('reports a second answer to one question as undelivered', async () => {
    const pending = askHuman(RUN, 'Ship it?', () => {});

    expect(answerPrompt(RUN, { decision: 'approved' })).toBe(true);
    expect(answerPrompt(RUN, { decision: 'rejected' })).toBe(false);

    await expect(pending).resolves.toMatchObject({ decision: 'approved' });
  });
});

describe('cancel', () => {
  it('releases a waiting run with the reason', async () => {
    const pending = askHuman(RUN, 'Ship it?', () => {});

    cancel(RUN, 'the dashboard disconnected');

    await expect(pending).resolves.toEqual({
      decision: 'rejected',
      data: 'the dashboard disconnected',
    });
  });

  it('does nothing for a run that is not waiting', () => {
    expect(() => cancel('never-asked', 'reason')).not.toThrow();
  });
});

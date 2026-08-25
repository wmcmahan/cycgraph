/**
 * Pending human prompts
 *
 * A run that reaches an approval gate has to ask someone. The CLI can read the
 * terminal; the dashboard could not, so it approved everything and said so in
 * a comment. That made every gated scenario report a decision nobody made.
 *
 * Server-sent events only travel one way, which is what the comment was really
 * about. The other direction is an ordinary POST: the run's callback parks a
 * promise here, the page is told a question is waiting, and the answer resolves
 * it. Nothing about the engine changes — this is the same
 * `(question) => Promise<HumanResponse>` the terminal prompt satisfies.
 *
 * @module server/prompts
 */

import type { HumanResponse } from '@cycgraph/orchestrator';
import { createLogger } from '@cycgraph/orchestrator';

const logger = createLogger('playground.prompts');

/**
 * How long a question waits before answering itself.
 *
 * A browser tab that closes mid-gate would otherwise hold the run, its stack,
 * and its Postgres connection open indefinitely. The engine's own gate timeout
 * is measured in hours and is about the reviewer; this is about the socket.
 */
const ABANDONED_MS = 5 * 60 * 1000;

/** A question waiting on someone. */
interface Pending {
  question: string;
  resolve: (response: HumanResponse) => void;
  timer: NodeJS.Timeout;
}

/** Questions parked per run. */
const pending = new Map<string, Pending>();

/** Whether a run is currently waiting on an answer. */
export function isWaiting(runId: string): boolean {
  return pending.has(runId);
}

/**
 * Park a question and wait for {@link answerPrompt}.
 *
 * @param runId    The run asking.
 * @param question What to show the reviewer.
 * @param notify   Pushes the question down the run's SSE stream.
 */
export function askHuman(
  runId: string,
  question: string,
  notify: (question: string) => void,
): Promise<HumanResponse> {
  // A second gate in one run replaces the first: the run is single-threaded,
  // so an unanswered earlier question is one nobody can reach any more.
  cancel(runId, 'superseded');

  return new Promise<HumanResponse>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('prompt_abandoned', { run_id: runId, question });
      pending.delete(runId);
      resolve({ decision: 'rejected', data: 'no answer from the dashboard' });
    }, ABANDONED_MS);
    // Node holds the process open for a pending timer; a run waiting on a
    // reviewer should not be what keeps the CLI from exiting.
    timer.unref?.();

    pending.set(runId, { question, resolve, timer });
    notify(question);
  });
}

/**
 * Answer a parked question.
 *
 * @returns `false` when nothing was waiting, which is what a double-submit or
 *   a reload-then-answer looks like.
 */
export function answerPrompt(runId: string, response: HumanResponse): boolean {
  const waiting = pending.get(runId);
  if (!waiting) return false;

  clearTimeout(waiting.timer);
  pending.delete(runId);
  waiting.resolve(response);
  return true;
}

/** Abandon a run's question, so a disconnected stream releases the run. */
export function cancel(runId: string, reason: string): void {
  const waiting = pending.get(runId);
  if (!waiting) return;

  clearTimeout(waiting.timer);
  pending.delete(runId);
  waiting.resolve({ decision: 'rejected', data: reason });
}

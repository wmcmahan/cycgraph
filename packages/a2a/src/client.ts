/**
 * A2A client adapter
 *
 * @module client
 */

import type { Client as SdkClient } from '@a2a-js/sdk/client';
import type { A2AClient, A2ATaskResult } from '@cycgraph/orchestrator';
import { sdkClientFactory, type CreateSdkClient } from './connection.js';
import { isPending } from './task-state.js';
import { toResult } from './translate.js';

/** Options for {@link createA2AClient}. */
export interface A2AClientOptions {
  /** Construct the underlying SDK client. */
  createClient?: CreateSdkClient;
}

/**
 * Build an `A2AClient` the orchestrator can run `a2a` nodes against.
 *
 * `timeoutMs` bounds the WHOLE delivery — client construction, the
 * blocking `message/send`, and the settle polling that follows — and
 * `abortSignal` cancels it at any point. Both are enforced on the
 * in-flight requests themselves (the signal is threaded into the SDK's
 * fetch and every await is raced against it), not just checked between
 * polls: a remote that accepts the connection and stalls inside
 * `message/send` would otherwise hang the node forever.
 */
export function createA2AClient(options: A2AClientOptions = {}): A2AClient {
  const create = options.createClient ?? sdkClientFactory();

  async function deliver(
    agentCardUrl: string,
    headers: Record<string, string>,
    message: ReturnType<typeof userMessage>,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<A2ATaskResult> {
    const deadline = Date.now() + timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = abortSignal ? AbortSignal.any([timeout.signal, abortSignal]) : timeout.signal;

    try {
      const client = await raceAbort(create(agentCardUrl, headers, signal), signal);
      // Cast: the generated request type demands fields the server defaults.
      const task = await raceAbort(client.sendMessage({ message } as never), signal);
      return toResult(await settle(client, task, deadline, signal));
    } catch (error) {
      // A rejection here means no task was ever observed (settle absorbs
      // the bound once one exists), so the bound itself is the outcome.
      // A non-abort rejection is a real transport error, passed through.
      if (abortSignal?.aborted) {
        throw new Error('A2A delivery aborted by the caller before the remote responded', { cause: error });
      }
      if (timeout.signal.aborted) {
        throw new Error(`A2A delivery did not complete within the ${timeoutMs}ms budget`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** See {@link A2AClient.runTask} */
    runTask: (request) =>
      deliver(
        request.agentCardUrl,
        request.headers,
        userMessage(request.input),
        request.timeoutMs,
        request.abortSignal,
      ),

    /** See {@link A2AClient.resumeTask} */
    resumeTask: (request) =>
      deliver(
        request.agentCardUrl,
        request.headers,
        userMessage(request.response, request.taskId),
        request.timeoutMs,
        request.abortSignal,
      ),
  };
}

/**
 * Race a promise against the delivery signal, so an await cannot outlive
 * the budget even when the underlying SDK call ignores cancellation. The
 * losing promise is left to settle on its own; the point is that the NODE
 * observes the bound, not that the socket is guaranteed closed.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (!signal.aborted) {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error as Error); },
      );
    });
  }
  return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
}

/**
 * Build the outbound message. Parts use the SDK's in-memory `$case` form;
 * the SDK itself serializes to the wire's named-field form. A `taskId`
 * marks the message as a continuation of that task rather than a new one.
 */
function userMessage(value: unknown, taskId?: string) {
  return {
    messageId: crypto.randomUUID(),
    ...(taskId ? { taskId } : {}),
    role: 'ROLE_USER',
    parts: [{ content: { $case: 'data', value } }],
  };
}

/**
 * Poll until the task leaves a running state.
 *
 * `sendMessage` may return as soon as the task is accepted, so a
 * `submitted` or `working` response means the work is still in flight —
 * treating it as an outcome would report every slow agent as failed.
 *
 * Gives up at the deadline or on abort, returning the last observed task
 * so the caller reports a real state rather than a transport error — a
 * poll request cut off mid-flight by the bound resolves the same way.
 */
async function settle(
  client: SdkClient,
  first: unknown,
  deadline: number,
  signal: AbortSignal,
): Promise<unknown> {
  let task = first as { id?: string; status?: { state?: unknown } };
  let waitMs = 100;

  while (isPending(task.status?.state)) {
    if (signal.aborted || Date.now() >= deadline) {
      return task;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(waitMs, Math.max(0, deadline - Date.now()))),
    );

    waitMs = Math.min(waitMs * 2, 2_000);

    if (!task.id) {
      return task;
    }
    try {
      task = await raceAbort(client.getTask({ name: `tasks/${task.id}` } as never), signal);
    } catch (error) {
      // The bound fired while a poll was in flight: the last observed task
      // is still the honest answer. A non-abort rejection is a real
      // transport failure and keeps failing loudly.
      if (signal.aborted) return task;
      throw error;
    }
  }

  return task;
}

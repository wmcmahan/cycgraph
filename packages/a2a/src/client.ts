/**
 * A2A client adapter
 *
 * @module client
 */

import type { Client as SdkClient } from '@a2a-js/sdk/client';
import type { A2AClient, A2ATaskResult } from '@cycgraph/orchestrator';
import { sdkClientFactory, type CreateSdkClient } from './connection.js';
import { raceAbort } from './race.js';
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
 *
 * The request's `requestTimeoutMs`, when set, additionally bounds EACH
 * request on its own — every connection attempt (Agent Card resolution
 * and client construction) and every status poll — so a remote that
 * stalls one call fails fast instead of holding the node for the whole
 * `timeoutMs`. A request that outruns it rejects with a transport error;
 * a timed-out connection attempt counts as a failed attempt and is
 * retried like any other. The `message/send` is exempt: it may block
 * until the remote task finishes, so only `timeoutMs` bounds it.
 *
 * A failed client construction is retried up to the request's
 * `maxRetries` times with exponential backoff (1s, 2s, 4s…, capped at
 * 10s), inside the same budget. `message/send` is never retried.
 */
export function createA2AClient(options: A2AClientOptions = {}): A2AClient {
  const create = options.createClient ?? sdkClientFactory();

  async function connect(
    agentCardUrl: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    maxRetries: number,
    requestTimeoutMs: number | undefined,
    allowedEndpointHosts?: readonly string[],
  ): Promise<SdkClient> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await raceRequestBound(
          () => create(agentCardUrl, headers, signal, allowedEndpointHosts), signal, requestTimeoutMs);
      } catch (error) {
        if (signal.aborted || attempt >= maxRetries) throw error;
        await backoff(Math.min(1_000 * 2 ** attempt, MAX_CONNECT_BACKOFF_MS), signal);
      }
    }
  }

  async function deliver(
    agentCardUrl: string,
    headers: Record<string, string>,
    message: ReturnType<typeof userMessage>,
    timeoutMs: number,
    abortSignal?: AbortSignal,
    allowedEndpointHosts?: readonly string[],
    maxRetries = 0,
    requestTimeoutMs?: number,
  ): Promise<A2ATaskResult> {
    const deadline = Date.now() + timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = abortSignal ? AbortSignal.any([timeout.signal, abortSignal]) : timeout.signal;

    try {
      const client = await connect(
        agentCardUrl, headers, signal, maxRetries, requestTimeoutMs, allowedEndpointHosts);
      // Cast: the generated request type demands fields the server defaults.
      const task = await raceDeliveryBound(() => client.sendMessage({ message } as never), signal);
      return toResult(await settle(client, task, deadline, signal, requestTimeoutMs));
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
      // Releases any request a per-request timeout abandoned: the SDK
      // client is scoped to this delivery, so nothing legitimate is left.
      timeout.abort();
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
        request.allowedEndpointHosts,
        request.maxRetries,
        request.requestTimeoutMs,
      ),

    /** See {@link A2AClient.resumeTask} */
    resumeTask: (request) =>
      deliver(
        request.agentCardUrl,
        request.headers,
        userMessage(request.response, request.taskId),
        request.timeoutMs,
        request.abortSignal,
        request.allowedEndpointHosts,
        request.maxRetries,
        request.requestTimeoutMs,
      ),
  };
}

/** Ceiling on one backoff between connection attempts. */
const MAX_CONNECT_BACKOFF_MS = 10_000;

/**
 * Wait `ms` before the next connection attempt, rejecting as soon as the
 * delivery signal aborts so a backoff never outlives the budget.
 */
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Race a call against the delivery signal, so an await cannot outlive
 * the budget even when the underlying SDK call ignores cancellation. The
 * call is passed as a thunk: an already-bound delivery never issues it.
 */
function raceDeliveryBound<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return raceAbort(start, signal, () =>
    signal.reason instanceof Error ? signal.reason : new Error('aborted'));
}

/**
 * Race a call against the delivery signal and, when `requestTimeoutMs` is
 * set, against a timeout of its own. The delivery bound wins when both
 * fire, so a caller abort or an exhausted budget is still reported as
 * such; the per-request timeout alone rejects with a transport error.
 */
function raceRequestBound<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  requestTimeoutMs: number | undefined,
): Promise<T> {
  if (requestTimeoutMs === undefined) return raceDeliveryBound(start, signal);
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(), requestTimeoutMs);
  return raceAbort(start, AbortSignal.any([signal, request.signal]), () => {
    if (signal.aborted) return signal.reason instanceof Error ? signal.reason : new Error('aborted');
    return new Error(`A2A request did not respond within the ${requestTimeoutMs}ms request timeout`);
  }).finally(() => clearTimeout(timer));
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
  requestTimeoutMs: number | undefined,
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

    // Re-checked after the sleep: the last backoff is clamped to the
    // remaining budget, so the bound routinely fires while we wait and a
    // poll issued now would be born aborted.
    if (signal.aborted || Date.now() >= deadline) {
      return task;
    }

    if (!task.id) {
      return task;
    }
    try {
      task = await raceRequestBound(
        () => client.getTask({ name: `tasks/${task.id}` } as never), signal, requestTimeoutMs);
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

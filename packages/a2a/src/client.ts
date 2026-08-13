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
    const client = await create(agentCardUrl, headers);
    // Cast: the generated request type demands fields the server defaults.
    const task = await client.sendMessage({ message } as never);
    return toResult(await settle(client, task, timeoutMs, abortSignal));
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
 * Gives up at `timeoutMs` or on abort, returning the last observed task so
 * the caller reports a real state rather than a transport error.
 */
async function settle(
  client: SdkClient,
  first: unknown,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  let task = first as { id?: string; status?: { state?: unknown } };
  const deadline = Date.now() + timeoutMs;
  let waitMs = 100;

  while (isPending(task.status?.state)) {
    if (abortSignal?.aborted || Date.now() >= deadline) {
      return task;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(waitMs, Math.max(0, deadline - Date.now()))),
    );

    waitMs = Math.min(waitMs * 2, 2_000);

    if (!task.id) {
      return task;
    }
    task = await client.getTask({ name: `tasks/${task.id}` } as never);
  }

  return task;
}

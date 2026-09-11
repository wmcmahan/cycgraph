/**
 * Tests for the A2A client adapter.
 */

import { describe, it, expect, vi } from 'vitest';
import { createA2AClient, normalizeState, partsToValue, toResult } from '../src/index.js';

const textPart = (value: string) => ({ content: { $case: 'text', value } });
const dataPart = (value: unknown) => ({ content: { $case: 'data', value } });

describe('normalizeState', () => {
  it('maps protocol enum names to engine states', () => {
    expect(normalizeState('TASK_STATE_COMPLETED')).toBe('completed');
    expect(normalizeState('TASK_STATE_INPUT_REQUIRED')).toBe('input-required');
    expect(normalizeState('TASK_STATE_AUTH_REQUIRED')).toBe('auth-required');
    expect(normalizeState('TASK_STATE_REJECTED')).toBe('rejected');
  });

  it('maps the JSON spellings some servers emit', () => {
    expect(normalizeState('completed')).toBe('completed');
    expect(normalizeState('input-required')).toBe('input-required');
  });

  it('maps a still-running state to failure so a deadline never reads as success', () => {
    expect(normalizeState('TASK_STATE_WORKING')).toBe('failed');
    expect(normalizeState('working')).toBe('failed');
    expect(normalizeState('TASK_STATE_SUBMITTED')).toBe('failed');
  });

  it('treats an unspecified state as failure rather than guessing', () => {
    expect(normalizeState('TASK_STATE_UNSPECIFIED')).toBe('failed');
    expect(normalizeState('UNRECOGNIZED')).toBe('failed');
  });

  it('treats an unknown future state as failure', () => {
    expect(normalizeState('TASK_STATE_SOMETHING_NEW')).toBe('failed');
    expect(normalizeState(undefined)).toBe('failed');
  });
});

describe('partsToValue', () => {
  it('returns the string for a lone text part', () => {
    expect(partsToValue([textPart('the findings')])).toBe('the findings');
  });

  it('preserves structure for a lone data part', () => {
    expect(partsToValue([dataPart({ score: 0.9 })])).toEqual({ score: 0.9 });
  });

  it('returns an ordered array for several parts', () => {
    expect(partsToValue([textPart('a'), dataPart({ b: 1 })])).toEqual(['a', { b: 1 }]);
  });

  it('returns null for an empty part list', () => {
    expect(partsToValue([])).toBeNull();
  });

  it('describes a url part rather than fetching it', () => {
    const part = { content: { $case: 'url', value: 'https://x/y.pdf' }, mediaType: 'application/pdf' };

    expect(partsToValue([part])).toEqual({ url: 'https://x/y.pdf', mediaType: 'application/pdf' });
  });

  it('describes raw bytes rather than inlining them into workflow state', () => {
    const part = { content: { $case: 'raw', value: 'ignored' }, mediaType: 'image/png', filename: 'a.png' };

    expect(partsToValue([part])).toEqual({ bytes: true, mediaType: 'image/png', filename: 'a.png' });
  });

  it('degrades an unrecognized part kind to null rather than throwing', () => {
    const part = { content: { $case: 'file', value: { uri: 'file:///secret' } }, mediaType: 'image/png' };

    expect(partsToValue([part])).toBeNull();
  });

  it('degrades an unrecognized part kind to null beside recognized parts', () => {
    const part = { content: { $case: 'unknown', value: 'leaked' } };

    expect(partsToValue([textPart('a'), part])).toEqual(['a', null]);
  });
});

describe('toResult', () => {
  it('maps a completed task with named artifacts', () => {
    const result = toResult({
      id: 'task-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ name: 'report', parts: [textPart('done')] }],
    });

    expect(result).toEqual({ taskId: 'task-1', state: 'completed', artifacts: [{ name: 'report', value: 'done' }] });
  });

  it('falls back to the artifact id when a name is absent', () => {
    const result = toResult({
      id: 'task-1',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'art-9', parts: [textPart('x')] }],
    });

    expect(result.artifacts[0].name).toBe('art-9');
  });

  it('falls back to an index when neither name nor id is present', () => {
    const result = toResult({
      id: 'task-1',
      status: { state: 'completed' },
      artifacts: [{ parts: [textPart('x')] }],
    });

    expect(result.artifacts[0].name).toBe('artifact_0');
  });

  it('returns no artifacts for a non-completed task', () => {
    const result = toResult({
      id: 'task-1',
      status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      artifacts: [{ name: 'partial', parts: [textPart('x')] }],
    });

    expect(result.state).toBe('input-required');
    expect(result.artifacts).toEqual([]);
  });

  it('surfaces the status message so a pause can show the question', () => {
    const result = toResult({
      id: 'task-1',
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [textPart('Which region?')] } },
    });

    expect(result.message).toBe('Which region?');
  });

  it('keeps every part of a multi-part status message so the question survives', () => {
    const result = toResult({
      id: 'task-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: { parts: [textPart('Which region?'), dataPart({ options: ['EMEA', 'APAC'] })] },
      },
    });

    expect(result.message).toBe('Which region?\n{"options":["EMEA","APAC"]}');
  });

  it('renders a status message made only of a data part as its json', () => {
    const result = toResult({
      id: 'task-1',
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [dataPart({ question: 'region?' })] } },
    });

    expect(result.message).toBe('{"question":"region?"}');
  });

  it('omits the message when the status message carries no renderable parts', () => {
    const result = toResult({
      id: 'task-1',
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [] } },
    });

    expect(result.message).toBeUndefined();
  });

  it('completes a bare message reply with its parts as the response artifact', () => {
    const result = toResult({
      taskId: 'task-7',
      role: 'ROLE_AGENT',
      parts: [textPart('the answer')],
    });

    expect(result).toEqual({
      taskId: 'task-7',
      state: 'completed',
      artifacts: [{ name: 'response', value: 'the answer' }],
    });
  });

  it('completes a bare message reply that carries no task id', () => {
    const result = toResult({
      role: 'ROLE_AGENT',
      parts: [dataPart({ score: 0.5 })],
    });

    expect(result).toEqual({
      taskId: '',
      state: 'completed',
      artifacts: [{ name: 'response', value: { score: 0.5 } }],
    });
  });

  it('keeps a task carrying both parts and status on the task path', () => {
    const result = toResult({
      id: 'task-8',
      status: { state: 'TASK_STATE_FAILED' },
      role: 'ROLE_AGENT',
      parts: [textPart('ignored')],
    });

    expect(result).toEqual({ taskId: 'task-8', state: 'failed', artifacts: [] });
  });

});

describe('createA2AClient', () => {
  it('rejects within the budget when message/send never responds', async () => {
    vi.useFakeTimers();
    try {
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: () => new Promise(() => {}),
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 5_000,
      });
      const outcome = expect(pending).rejects.toThrow('did not complete within the 5000ms budget');
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const client = createA2AClient({
      createClient: async () => ({
        sendMessage: () => new Promise(() => {}),
      }) as never,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.runTask({
      agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 5_000,
      abortSignal: controller.signal,
    })).rejects.toThrow('aborted by the caller');
  });

  it('polls a working task until it completes and returns the settled result', async () => {
    vi.useFakeTimers();
    try {
      const polled: string[] = [];
      let polls = 0;
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: async () => ({ id: 't9', status: { state: 'TASK_STATE_WORKING' } }),
          getTask: async (params: { name: string }) => {
            polled.push(params.name);
            polls += 1;
            return polls < 2
              ? { id: 't9', status: { state: 'TASK_STATE_WORKING' } }
              : {
                  id: 't9',
                  status: { state: 'TASK_STATE_COMPLETED' },
                  artifacts: [{ parts: [{ content: { $case: 'data', value: { answer: 42 } } }] }],
                };
          },
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.state).toBe('completed');
      expect(polled).toEqual(['tasks/t9', 'tasks/t9']);
      expect(result.artifacts[0]?.value).toEqual({ answer: 42 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a pending task that carries no id instead of polling blind', async () => {
    vi.useFakeTimers();
    try {
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: async () => ({ status: { state: 'TASK_STATE_WORKING' } }),
          getTask: async () => { throw new Error('must not be called without a task id'); },
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.state).toBe('failed');
      expect(result.taskId).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the last observed task when a poll hangs past the deadline', async () => {
    vi.useFakeTimers();
    try {
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: async () => ({ id: 't1', status: { state: 'TASK_STATE_WORKING' } }),
          getTask: () => new Promise(() => {}),
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 3_000,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;

      expect(result.taskId).toBe('t1');
      expect(result.state).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the delivery signal to the client factory', async () => {
    let received: AbortSignal | undefined;
    const client = createA2AClient({
      createClient: async (_url, _headers, signal) => {
        received = signal;
        return { sendMessage: async () => ({ id: 't', status: { state: 'completed' }, artifacts: [] }) } as never;
      },
    });

    await client.runTask({ agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 1_000 });

    expect(received).toBeInstanceOf(AbortSignal);
  });

  it('sends the mapped input as a data part', async () => {
    const sent: any[] = [];
    const client = createA2AClient({
      createClient: async () => ({
        sendMessage: async (params: any) => {
          sent.push(params);
          return { id: 't1', status: { state: 'completed' }, artifacts: [] };
        },
      }) as never,
    });

    await client.runTask({
      agentCardUrl: 'https://x/card.json', headers: {}, input: { query: 'batteries' }, timeoutMs: 1000,
    });

    expect(sent[0].message.parts[0].content).toEqual({ $case: 'data', value: { query: 'batteries' } });
  });

  it('carries the task id when resuming so the agent continues the same task', async () => {
    const sent: any[] = [];
    const client = createA2AClient({
      createClient: async () => ({
        sendMessage: async (params: any) => {
          sent.push(params);
          return { id: 'task-7', status: { state: 'completed' }, artifacts: [] };
        },
      }) as never,
    });

    await client.resumeTask({
      agentCardUrl: 'https://x/card.json', headers: {}, taskId: 'task-7', response: 'EMEA', timeoutMs: 1000,
    });

    expect(sent[0].message.taskId).toBe('task-7');
    expect(sent[0].message.parts[0].content.value).toBe('EMEA');
  });

  it('passes the engine headers to the transport factory', async () => {
    const seen: Record<string, string>[] = [];
    const client = createA2AClient({
      createClient: async (_url, headers) => {
        seen.push(headers);
        return { sendMessage: async () => ({ id: 't', status: { state: 'completed' }, artifacts: [] }) } as never;
      },
    });

    await client.runTask({
      agentCardUrl: 'https://x/card.json',
      headers: { authorization: 'Bearer s', traceparent: '00-abc-def-01' },
      input: {},
      timeoutMs: 1000,
    });

    expect(seen[0]).toEqual({ authorization: 'Bearer s', traceparent: '00-abc-def-01' });
  });

  it('returns a failed state rather than throwing when a task ends badly', async () => {
    const client = createA2AClient({
      createClient: async () => ({
        sendMessage: async () => ({ id: 't', status: { state: 'TASK_STATE_REJECTED' } }),
      }) as never,
    });

    const result = await client.runTask({
      agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 1000,
    });

    expect(result.state).toBe('rejected');
  });

  it('passes a message/send transport failure through unchanged', async () => {
    const transportError = new Error('ECONNRESET');
    const client = createA2AClient({
      createClient: async () => ({
        sendMessage: async () => { throw transportError; },
      }) as never,
    });

    await expect(client.runTask({
      agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 5_000,
    })).rejects.toBe(transportError);
  });

  it('passes a transport failure mid-poll through unchanged', async () => {
    vi.useFakeTimers();
    try {
      const transportError = new Error('ECONNRESET');
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: async () => ({ id: 't5', status: { state: 'TASK_STATE_WORKING' } }),
          getTask: async () => { throw transportError; },
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 60_000,
      });
      const outcome = expect(pending).rejects.toBe(transportError);
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});

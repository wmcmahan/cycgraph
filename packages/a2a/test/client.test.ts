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

  it.each([
    ['TASK_STATE_FAILED', 'failed'],
    ['TASK_STATE_CANCELED', 'canceled'],
    ['TASK_STATE_INPUT_REQUIRED', 'input-required'],
    ['TASK_STATE_REJECTED', 'rejected'],
    ['TASK_STATE_AUTH_REQUIRED', 'auth-required'],
  ])('returns no artifacts for a non-completed %s task', (wireState, state) => {
    const result = toResult({
      id: 'task-1',
      status: { state: wireState },
      artifacts: [{ name: 'partial', parts: [textPart('x')] }],
    });

    expect(result.state).toBe(state);
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

  it('reports a message-shaped reply without a role as a failed task', () => {
    const result = toResult({
      parts: [textPart('the answer')],
    });

    expect(result).toEqual({ taskId: '', state: 'failed', artifacts: [] });
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

  it('never builds a client when the caller signal is already aborted', async () => {
    let creations = 0;
    const client = createA2AClient({
      createClient: async () => {
        creations += 1;
        throw new Error('agent card url points at a private/loopback host and is blocked (SSRF guard)');
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.runTask({
      agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 5_000,
      abortSignal: controller.signal,
    })).rejects.toThrow('aborted by the caller');
    expect(creations).toBe(0);
  });

  it('issues no further poll when the backoff sleep ends on the deadline', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: async () => ({ id: 't1', status: { state: 'TASK_STATE_WORKING' } }),
          getTask: async () => {
            polls += 1;
            throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
          },
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(polls).toBe(0);
      expect(result.taskId).toBe('t1');
      expect(result.state).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
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

  it('doubles the poll interval from 100ms and caps it at 2000ms', async () => {
    vi.useFakeTimers();
    try {
      const pollOffsets: number[] = [];
      const start = Date.now();
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: async () => ({ id: 't3', status: { state: 'TASK_STATE_WORKING' } }),
          getTask: async () => {
            pollOffsets.push(Date.now() - start);
            return pollOffsets.length < 8
              ? { id: 't3', status: { state: 'TASK_STATE_WORKING' } }
              : { id: 't3', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [] };
          },
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(9_100);
      const result = await pending;

      expect(pollOffsets).toEqual([100, 300, 700, 1_500, 3_100, 5_100, 7_100, 9_100]);
      expect(result.state).toBe('completed');
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

  it('passes a run request allowed endpoint hosts to the transport factory', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const client = createA2AClient({
      createClient: async (_url, _headers, _signal, allowedEndpointHosts) => {
        seen.push(allowedEndpointHosts);
        return { sendMessage: async () => ({ id: 't', status: { state: 'completed' }, artifacts: [] }) } as never;
      },
    });

    await client.runTask({
      agentCardUrl: 'https://cards.example/card.json',
      headers: {},
      input: {},
      timeoutMs: 1000,
      allowedEndpointHosts: ['rpc.example.com', 'alt.example.com'],
    });

    expect(seen).toEqual([['rpc.example.com', 'alt.example.com']]);
  });

  it('passes a resume request allowed endpoint hosts to the transport factory', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const client = createA2AClient({
      createClient: async (_url, _headers, _signal, allowedEndpointHosts) => {
        seen.push(allowedEndpointHosts);
        return {
          sendMessage: async () => ({ id: 'task-7', status: { state: 'completed' }, artifacts: [] }),
        } as never;
      },
    });

    await client.resumeTask({
      agentCardUrl: 'https://cards.example/card.json',
      headers: {},
      taskId: 'task-7',
      response: 'EMEA',
      timeoutMs: 1000,
      allowedEndpointHosts: ['rpc.example.com'],
    });

    expect(seen).toEqual([['rpc.example.com']]);
  });

  it('passes no allowed endpoint hosts when the request omits them', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const client = createA2AClient({
      createClient: async (_url, _headers, _signal, allowedEndpointHosts) => {
        seen.push(allowedEndpointHosts);
        return { sendMessage: async () => ({ id: 't', status: { state: 'completed' }, artifacts: [] }) } as never;
      },
    });

    await client.runTask({
      agentCardUrl: 'https://cards.example/card.json', headers: {}, input: {}, timeoutMs: 1000,
    });

    expect(seen).toEqual([undefined]);
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

  it('retries a failed client construction with backoff until it connects', async () => {
    vi.useFakeTimers();
    try {
      const attemptOffsets: number[] = [];
      const start = Date.now();
      const client = createA2AClient({
        createClient: async () => {
          attemptOffsets.push(Date.now() - start);
          if (attemptOffsets.length < 3) throw new Error('ECONNREFUSED');
          return { sendMessage: async () => ({ id: 't', status: { state: 'completed' }, artifacts: [] }) } as never;
        },
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 60_000, maxRetries: 2,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;

      expect(attemptOffsets).toEqual([0, 1_000, 3_000]);
      expect(result.state).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed client construction when resuming a task', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const client = createA2AClient({
        createClient: async () => {
          attempts += 1;
          if (attempts < 2) throw new Error('ECONNREFUSED');
          return {
            sendMessage: async () => ({ id: 'task-7', status: { state: 'completed' }, artifacts: [] }),
          } as never;
        },
      });

      const pending = client.resumeTask({
        agentCardUrl: 'https://x/card.json', headers: {}, taskId: 'task-7', response: 'EMEA',
        timeoutMs: 60_000, maxRetries: 1,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(attempts).toBe(2);
      expect(result.taskId).toBe('task-7');
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the last connection failure through once retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const client = createA2AClient({
        createClient: async () => {
          attempts += 1;
          throw new Error(`ECONNREFUSED ${attempts}`);
        },
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 60_000, maxRetries: 2,
      });
      const outcome = expect(pending).rejects.toThrow('ECONNREFUSED 3');
      await vi.advanceTimersByTimeAsync(3_000);
      await outcome;

      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes one connection attempt when the request sets no retries', async () => {
    let attempts = 0;
    const client = createA2AClient({
      createClient: async () => {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(client.runTask({
      agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 5_000,
    })).rejects.toThrow('ECONNREFUSED');
    expect(attempts).toBe(1);
  });

  it('fails a stalled message/send at the request timeout rather than the task budget', async () => {
    vi.useFakeTimers();
    try {
      const client = createA2AClient({
        createClient: async () => ({
          sendMessage: () => new Promise(() => {}),
        }) as never,
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 600_000, requestTimeoutMs: 5_000,
      });
      const outcome = expect(pending).rejects.toThrow('did not respond within the 5000ms request timeout');
      await vi.advanceTimersByTimeAsync(5_000);

      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a connection attempt that outruns the request timeout', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const client = createA2AClient({
        createClient: async () => {
          attempts += 1;
          if (attempts < 2) return new Promise(() => {});
          return { sendMessage: async () => ({ id: 't', status: { state: 'completed' }, artifacts: [] }) } as never;
        },
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 600_000,
        maxRetries: 1, requestTimeoutMs: 2_000,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;

      expect(attempts).toBe(2);
      expect(result.state).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying a connection when the budget runs out during backoff', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const client = createA2AClient({
        createClient: async () => {
          attempts += 1;
          throw new Error('ECONNREFUSED');
        },
      });

      const pending = client.runTask({
        agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 500, maxRetries: 5,
      });
      const outcome = expect(pending).rejects.toThrow('did not complete within the 500ms budget');
      await vi.advanceTimersByTimeAsync(500);
      await outcome;

      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never resends message/send when retries are configured', async () => {
    let sends = 0;
    const transportError = new Error('ECONNRESET');
    const client = createA2AClient({
      createClient: async () => ({
        sendMessage: async () => {
          sends += 1;
          throw transportError;
        },
      }) as never,
    });

    await expect(client.runTask({
      agentCardUrl: 'https://x/card.json', headers: {}, input: {}, timeoutMs: 5_000, maxRetries: 3,
    })).rejects.toBe(transportError);
    expect(sends).toBe(1);
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

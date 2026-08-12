/**
 * Tests for the A2A client adapter.
 */

import { describe, it, expect } from 'vitest';
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

});

describe('createA2AClient', () => {
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
});

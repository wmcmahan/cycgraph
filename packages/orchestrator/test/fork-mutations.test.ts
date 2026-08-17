/**
 * Tests for the change vocabulary (src/replay/mutations.ts): the builders, the
 * wire schema they produce, how a change describes itself, and which pairs of
 * changes collide.
 */

import { describe, it, expect } from 'vitest';
import { change, ChangeSchema, describeChange, detectConflicts, isAgentChange } from '../src/replay/mutations.js';

describe('change builders', () => {
  it('builds a model change', () => {
    expect(change.model('write', 'claude-opus-5')).toEqual({
      kind: 'model', target: 'write', model: 'claude-opus-5',
    });
  });

  it('carries a provider only when given', () => {
    expect(change.model('write', 'gpt-5', { provider: 'openai' }).provider).toBe('openai');
    expect('provider' in change.model('write', 'gpt-5')).toBe(false);
  });

  it('builds a prompt change under the wire field name', () => {
    expect(change.prompt('write', 'be terse')).toEqual({
      kind: 'prompt', target: 'write', system_prompt: 'be terse',
    });
  });

  it('builds a temperature change', () => {
    expect(change.temperature('write', 0)).toEqual({
      kind: 'temperature', target: 'write', temperature: 0,
    });
  });

  it('omits absent halves of a memory patch', () => {
    expect(change.memory({ set: { a: 1 } })).toEqual({ kind: 'memory', set: { a: 1 } });
    expect(change.memory({ delete: ['b'] })).toEqual({ kind: 'memory', delete: ['b'] });
  });

  it('builds a node config patch', () => {
    expect(change.config('boss', { max_iterations: 2 })).toEqual({
      kind: 'config', node_id: 'boss', patch: { max_iterations: 2 },
    });
  });

  it('builds a route change and carries once only when set', () => {
    expect(change.route('a', 'b')).toEqual({ kind: 'route', from_node_id: 'a', to_node_id: 'b' });
    expect(change.route('a', 'b', { once: true }).once).toBe(true);
  });

  it('builds output and tool substitutions', () => {
    expect(change.output('write', { draft: 'x' })).toEqual({
      kind: 'output', node_id: 'write', memory: { draft: 'x' },
    });
    expect(change.tool('fetch', 42)).toEqual({ kind: 'tool', node_id: 'fetch', result: 42 });
  });

  it('builds a human response, carrying data and memory updates when given', () => {
    expect(change.humanResponse('approved')).toEqual({
      kind: 'human_response', decision: 'approved',
    });
    expect(change.humanResponse('edited', { data: 'note', memoryUpdates: { k: 1 } })).toEqual({
      kind: 'human_response', decision: 'edited', data: 'note', memory_updates: { k: 1 },
    });
  });
});

describe('ChangeSchema', () => {
  it('accepts every builder output', () => {
    const all = [
      change.model('n', 'm'),
      change.prompt('n', 'p'),
      change.temperature('n', 0.5),
      change.memory({ set: { a: 1 } }),
      change.config('n', { x: 1 }),
      change.route('a', 'b'),
      change.output('n', { k: 1 }),
      change.tool('n', 'r'),
      change.humanResponse('rejected'),
    ];

    for (const c of all) expect(ChangeSchema.safeParse(c).success).toBe(true);
  });

  it('rejects a temperature outside the sampling range', () => {
    expect(ChangeSchema.safeParse({ kind: 'temperature', target: 'n', temperature: 2 }).success)
      .toBe(false);
  });

  it('rejects an unknown change kind', () => {
    expect(ChangeSchema.safeParse({ kind: 'teleport', target: 'n' }).success).toBe(false);
  });
});

describe('isAgentChange', () => {
  it('is true for the changes that resolve a target to an agent', () => {
    expect(isAgentChange(change.model('n', 'm'))).toBe(true);
    expect(isAgentChange(change.prompt('n', 'p'))).toBe(true);
    expect(isAgentChange(change.temperature('n', 1))).toBe(true);
  });

  it('is false for everything else', () => {
    expect(isAgentChange(change.memory({ set: {} }))).toBe(false);
    expect(isAgentChange(change.output('n', {}))).toBe(false);
    expect(isAgentChange(change.humanResponse('approved'))).toBe(false);
  });
});

describe('describeChange', () => {
  it('names the target and the new value for an agent change', () => {
    expect(describeChange(change.model('write', 'opus'))).toBe("model of 'write' → opus");
    expect(describeChange(change.temperature('write', 0))).toBe("temperature of 'write' → 0");
  });

  it('describes each remaining kind', () => {
    expect(describeChange(change.prompt('w', 'x'))).toBe("prompt of 'w'");
    expect(describeChange(change.config('w', {}))).toBe("config of 'w'");
    expect(describeChange(change.route('a', 'b'))).toBe("route 'a' → 'b'");
    expect(describeChange(change.output('w', {}))).toBe("output of 'w'");
    expect(describeChange(change.tool('w', 1))).toBe("tool result of 'w'");
    expect(describeChange(change.humanResponse('approved'))).toBe("human response 'approved'");
  });

  it('lists what a memory patch sets and deletes', () => {
    expect(describeChange(change.memory({ set: { a: 1 }, delete: ['b'] })))
      .toBe('memory set a and delete b');
  });

  it('says so when a memory patch does nothing', () => {
    expect(describeChange(change.memory({}))).toBe('memory (no-op)');
  });
});

describe('detectConflicts', () => {
  it('passes a coherent set', () => {
    expect(detectConflicts([
      change.model('write', 'm'),
      change.prompt('write', 'p'),
      change.memory({ set: { a: 1 } }),
    ])).toEqual([]);
  });

  it('catches two changes to the same agent field', () => {
    const conflicts = detectConflicts([change.model('w', 'a'), change.model('w', 'b')]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('both write model:w');
  });

  it('allows the same field on different targets', () => {
    expect(detectConflicts([change.model('a', 'm'), change.model('b', 'm')])).toEqual([]);
  });

  it('catches two memory patches touching one key', () => {
    expect(detectConflicts([
      change.memory({ set: { draft: 1 } }),
      change.memory({ delete: ['draft'] }),
    ])).toHaveLength(1);
  });

  it('catches an output and a tool change deciding one node output', () => {
    const conflicts = detectConflicts([change.output('n', { a: 1 }), change.tool('n', 'r')]);

    expect(conflicts[0]).toContain('both write output:n');
  });

  it('catches two config patches to the same field', () => {
    expect(detectConflicts([
      change.config('n', { max_iterations: 1 }),
      change.config('n', { max_iterations: 2 }),
    ])).toHaveLength(1);
  });

  it('allows config patches to different fields of one node', () => {
    expect(detectConflicts([
      change.config('n', { max_iterations: 1 }),
      change.config('n', { read_keys: ['a'] }),
    ])).toEqual([]);
  });

  it('catches two answers to the run gates', () => {
    expect(detectConflicts([
      change.humanResponse('approved'),
      change.humanResponse('rejected'),
    ])).toHaveLength(1);
  });

  it('catches two routes leaving one node', () => {
    expect(detectConflicts([change.route('a', 'b'), change.route('a', 'c')])).toHaveLength(1);
  });

  it('reports both changes by name so the collision is actionable', () => {
    const [message] = detectConflicts([change.model('w', 'a'), change.model('w', 'b')]);

    expect(message).toContain("model of 'w' → a");
    expect(message).toContain("model of 'w' → b");
  });
});

/**
 * Declared memory keys.
 *
 * A key several nodes share has no owning node to name it, so without a
 * declaration it is retyped at every use site — grants, verifier targets, the
 * seeded state, and prompt text.
 */

import { describe, it, expect } from 'vitest';
import { GraphSpecError, graph, memoryKeys, node, state } from '../src/index.js';

const declared = () => memoryKeys({
  email_text: { seeded: true, schema: { type: 'string' }, description: 'the customer email' },
  purchase_order: { schema: { type: 'object' } },
});

describe('memoryKeys', () => {
  it('gives each key its own name', () => {
    const mem = declared();

    expect({ email: mem.email_text, order: mem.purchase_order })
      .toEqual({ email: 'email_text', order: 'purchase_order' });
  });

  it('refuses a key that would collide with a helper', () => {
    expect(() => memoryKeys({ inputs: { seeded: true } })).toThrow(GraphSpecError);
  });

  it('names the reserved word in the refusal', () => {
    expect(() => memoryKeys({ seed: {} })).toThrow(/'seed' is reserved/);
  });
});

describe('memoryKeys inputs', () => {
  it('declares only the seeded keys', () => {
    expect(Object.keys(declared().inputs)).toEqual(['email_text']);
  });

  it('carries the schema and description onto the declaration', () => {
    expect(declared().inputs['email_text'])
      .toEqual({ schema: { type: 'string' }, required: true, description: 'the customer email' });
  });

  it('satisfies strict key checking for a seeded read', () => {
    const mem = declared();
    const read = node({ id: 'read', type: 'router', reads: [mem.email_text] });
    const g = graph({
      name: 'seeded',
      nodes: [read],
      startNode: read,
      endNodes: [read],
      inputs: mem.inputs,
      strictKeys: true,
    });

    expect(g.inputs).toEqual({
      email_text: { schema: { type: 'string' }, required: true, description: 'the customer email' },
    });
  });

  it('is invisible to spread, so a declaration yields only its keys', () => {
    expect(Object.keys({ ...declared() })).toEqual(['email_text', 'purchase_order']);
  });
});

describe('memoryKeys seed', () => {
  it('returns the seeded memory', () => {
    expect(declared().seed({ email_text: 'hello' })).toEqual({ email_text: 'hello' });
  });

  it('refuses a key the declaration does not mention', () => {
    expect(() => declared().seed({ email_text: 'x', stray: 1 } as never))
      .toThrow(/'stray' is not a declared key/);
  });

  it('refuses a key a node writes rather than the caller seeding it', () => {
    expect(() => declared().seed({ email_text: 'x', purchase_order: {} } as never))
      .toThrow(/written by a node/);
  });

  it('refuses a required key that was left out', () => {
    expect(() => declared().seed({} as never)).toThrow(/required key 'email_text'/);
  });

  it('accepts an optional seeded key being absent', () => {
    const mem = memoryKeys({ note: { seeded: true, required: false } });

    expect(mem.seed({})).toEqual({});
  });

  it('feeds initial state directly', () => {
    const mem = declared();
    const read = node({ id: 'read', type: 'router', reads: [mem.email_text] });
    const g = graph({ name: 'seeded', nodes: [read], startNode: read, endNodes: [read], inputs: mem.inputs });

    const s = state({ workflowId: g.id, goal: 'go', memory: mem.seed({ email_text: 'hello' }) });

    expect(s.memory).toEqual({ email_text: 'hello' });
  });
});

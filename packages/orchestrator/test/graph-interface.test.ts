/**
 * Tests for the graph interface declarations (src/authoring/interface.ts +
 * the wire fields on GraphSchema): Zod-to-JSON-Schema projection, required
 * derivation, opaque key preservation, and the compile-time validation of
 * subgraph mappings against a child's declared interface.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../src/authoring/agent.js';
import { node } from '../src/authoring/node.js';
import { subgraph } from '../src/authoring/subgraph.js';
import { graph, GraphSpecError } from '../src/authoring/graph.js';
import type { Graph } from '../src/types/graph.js';

function childWithInterface(overrides: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> } = {}): Graph {
  const worker = node({
    id: 'worker',
    agent: agent({ model: 'claude-sonnet-4-6', instructions: 'work' }),
    reads: ['topic'],
    writes: 'summary',
  });
  return graph({
    name: 'child',
    nodes: [worker],
    edges: [],
    inputs: (overrides.inputs ?? { topic: z.string() }) as Record<string, z.ZodType>,
    outputs: (overrides.outputs ?? { summary: z.string() }) as Record<string, z.ZodType>,
  });
}

describe('graph — interface declarations', () => {
  it('projects zod inputs and outputs to JSON Schema on the wire', () => {
    const g = graph({
      name: 'declared',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
      inputs: { topic: z.string() },
      outputs: { summary: z.string(), sources: z.array(z.string()) },
    });

    expect(g.inputs?.topic.schema).toMatchObject({ type: 'string' });
    expect(g.inputs?.topic.required).toBe(true);
    expect(g.outputs?.summary.schema).toMatchObject({ type: 'string' });
    expect(g.outputs?.sources.schema).toMatchObject({ type: 'array', items: { type: 'string' } });
  });

  it('derives required false from an optional zod schema', () => {
    const g = graph({
      name: 'declared',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
      inputs: { hint: z.string().optional() },
    });

    expect(g.inputs?.hint.required).toBe(false);
  });

  it('accepts full entries with explicit required and description', () => {
    const g = graph({
      name: 'declared',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
      inputs: { topic: { schema: z.string(), required: false, description: 'what to research' } },
    });

    expect(g.inputs?.topic).toEqual({
      schema: expect.objectContaining({ type: 'string' }),
      required: false,
      description: 'what to research',
    });
  });

  it('passes raw JSON Schema through untouched', () => {
    const raw = { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false };
    const g = graph({
      name: 'declared',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
      inputs: { payload: raw },
    });

    expect(g.inputs?.payload.schema).toEqual(raw);
  });

  it('preserves camelCase memory keys in interface records', () => {
    const g = graph({
      name: 'declared',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
      inputs: { researchTopic: z.string() },
    });

    expect(Object.keys(g.inputs ?? {})).toEqual(['researchTopic']);
  });

  it('rejects a zod schema that cannot be represented as JSON Schema', () => {
    expect(() =>
      graph({
        name: 'declared',
        nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
        inputs: { amount: z.bigint() },
      }),
    ).toThrow(GraphSpecError);
  });

  it('accepts an output entry with a description', () => {
    const g = graph({
      name: 'declared',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
      outputs: { summary: { schema: z.string(), description: 'the digest' } },
    });

    expect(g.outputs?.summary).toEqual({
      schema: expect.objectContaining({ type: 'string' }),
      description: 'the digest',
    });
  });

  it('leaves the wire free of interface fields when none are declared', () => {
    const g = graph({
      name: 'undeclared',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
    });

    expect(JSON.stringify(g)).not.toContain('"inputs"');
    expect(JSON.stringify(g)).not.toContain('"outputs"');
  });
});

describe('graph — subgraph mapping validation', () => {
  it('compiles a mapping that matches the declared interface', () => {
    const child = childWithInterface();
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, {
          id: 'call',
          inputs: { subject: 'topic' },
          outputs: { summary: 'findings' },
          writes: 'findings',
        }),
      ],
    });

    expect(parent.nodes[0].subgraph_config?.input_mapping).toEqual({ subject: 'topic' });
  });

  it('rejects a mapping into an undeclared child input', () => {
    const child = childWithInterface();

    expect(() =>
      graph({
        name: 'parent',
        nodes: [
          subgraph(child, {
            id: 'call',
            inputs: { subject: 'goal_in' },
            outputs: { summary: 'findings' },
            writes: 'findings',
          }),
        ],
      }),
    ).toThrow(GraphSpecError);
  });

  it('rejects a mapping from an undeclared child output', () => {
    const child = childWithInterface();

    expect(() =>
      graph({
        name: 'parent',
        nodes: [
          subgraph(child, {
            id: 'call',
            inputs: { subject: 'topic' },
            outputs: { draft: 'findings' },
            writes: 'findings',
          }),
        ],
      }),
    ).toThrow(GraphSpecError);
  });

  it('rejects an unmapped required child input', () => {
    const child = childWithInterface();

    expect(() =>
      graph({
        name: 'parent',
        nodes: [subgraph(child, { id: 'call', outputs: { summary: 'findings' }, writes: 'findings' })],
      }),
    ).toThrow(GraphSpecError);
  });

  it('allows an optional child input to stay unmapped', () => {
    const child = childWithInterface({ inputs: { hint: z.string().optional() } });
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(child, { id: 'call', outputs: { summary: 'findings' }, writes: 'findings' })],
    });

    expect(parent.nodes[0].subgraph_config?.subgraph_id).toBe(child.id);
  });

  it('validates nothing for a child without a declared interface', () => {
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'work' }),
      writes: 'out',
    });
    const child = graph({ name: 'plain-child', nodes: [worker], edges: [] });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, { id: 'call', inputs: { a: 'anything' }, outputs: { whatever: 'r' }, writes: 'r' }),
      ],
    });

    expect(parent.nodes[0].subgraph_config?.subgraph_id).toBe(child.id);
  });
});

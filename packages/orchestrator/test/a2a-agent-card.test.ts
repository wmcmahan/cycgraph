/**
 * Tests for the Agent Card projection (a2a/agent-card.ts).
 *
 * The projection is lossy by construction, so the cases that matter are
 * what survives, what does not, and whether a publisher can tell.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toAgentCard, agentCardFidelity } from '../src/a2a/agent-card.js';
import { agent, node, graph, bundle } from '../src/index.js';

const INTERFACES = [{ url: 'https://agents.example.com/a2a/v1', transport: 'JSONRPC' }];

function researchGraph() {
  return graph({
    name: 'research-block',
    description: 'Researches a topic and returns notes plus a summary.',
    nodes: [node({
      id: 'gather',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'research' }),
      reads: ['topic'],
      writes: 'summary',
    })],
    inputs: {
      topic: { schema: z.string().min(3), description: 'The subject to research' },
      depth: { schema: z.enum(['brief', 'deep']).default('brief'), description: 'How much detail' },
    },
    outputs: {
      summary: { schema: z.string(), description: 'The five most important points' },
      sources: { schema: z.array(z.string()) },
    },
  });
}

describe('toAgentCard', () => {
  it('publishes the graph name and description', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.name).toBe('research-block');
    expect(card.description).toContain('Researches a topic');
  });

  it('publishes exactly one skill, because a graph is one unit of work', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.skills).toHaveLength(1);
  });

  it('renders declared inputs into the skill description', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.skills[0].description).toContain('topic: string');
    expect(card.skills[0].description).toContain('The subject to research');
  });

  it('marks a derived-optional input as optional', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.skills[0].description).toContain('depth (optional)');
  });

  it('summarises an enum schema by its members', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.skills[0].description).toContain('enum(brief | deep)');
  });

  it('summarises an array schema by its item type', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.skills[0].description).toContain('sources: array<string>');
  });

  it('carries the supplied interfaces through unchanged', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.supportedInterfaces).toEqual(INTERFACES);
  });

  it('refuses to publish a card with no endpoint', () => {
    expect(() => toAgentCard(researchGraph(), { interfaces: [], version: '1.0.0' }))
      .toThrow(/at least one interface/);
  });

  it('refuses to publish without a version', () => {
    expect(() => toAgentCard(researchGraph(), { interfaces: INTERFACES }))
      .toThrow(/requires a version/);
  });

  it('takes name and version from a bundle manifest when given one', () => {
    const artifact = bundle(researchGraph(), { version: '2.1.0', name: 'acme-research' });

    const card = toAgentCard(artifact, { interfaces: INTERFACES });

    expect(card.name).toBe('acme-research');
    expect(card.version).toBe('2.1.0');
  });

  it('includes optional provider and documentation when supplied', () => {
    const card = toAgentCard(researchGraph(), {
      interfaces: INTERFACES,
      version: '1.0.0',
      provider: { organization: 'Acme', url: 'https://acme.example.com' },
      documentationUrl: 'https://acme.example.com/docs',
    });

    expect(card.provider).toEqual({ organization: 'Acme', url: 'https://acme.example.com' });
    expect(card.documentationUrl).toBe('https://acme.example.com/docs');
  });

  it('omits provider and documentation when they are not supplied', () => {
    const card = toAgentCard(researchGraph(), { interfaces: INTERFACES, version: '1.0.0' });

    expect('provider' in card).toBe(false);
    expect('documentationUrl' in card).toBe(false);
  });

  it('publishes a graph that declares no interface', () => {
    const bare = graph({
      name: 'bare',
      description: 'No declared interface.',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
    });

    const card = toAgentCard(bare, { interfaces: INTERFACES, version: '1.0.0' });

    expect(card.skills[0].description).toBe('No declared interface.');
  });
});

describe('agentCardFidelity', () => {
  it('reports every declared key as unexpressed, because cards carry no schemas', () => {
    const fidelity = agentCardFidelity(researchGraph());

    expect(fidelity.lossless).toBe(false);
    expect(fidelity.unexpressedInputs).toEqual(['topic', 'depth']);
    expect(fidelity.unexpressedOutputs).toEqual(['summary', 'sources']);
  });

  it('reports a graph with no declared interface as lossless', () => {
    const bare = graph({
      name: 'bare',
      nodes: [node({ id: 'n', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }) })],
    });

    expect(agentCardFidelity(bare)).toEqual({
      lossless: true,
      unexpressedInputs: [],
      unexpressedOutputs: [],
    });
  });

  it('reads through a bundle to the graph it wraps', () => {
    const artifact = bundle(researchGraph(), { version: '1.0.0' });

    expect(agentCardFidelity(artifact).unexpressedInputs).toEqual(['topic', 'depth']);
  });
});

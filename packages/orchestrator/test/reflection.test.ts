/**
 * Reflection node — schema, validation, and end-to-end dispatch tests.
 *
 * Covers:
 * - Schema parse / reject for both extractor variants.
 * - Validator coverage for missing config and read_keys mismatches.
 * - The `rule_based` extractor: sentence splitting, dedup, min-length,
 *   multi-source concat, entity_keys, and custom result_key.
 * - The `llm` extractor: agent_id + instruction + max_facts wired into
 *   `extractFactsExecutor`, returned sentences persisted with
 *   `provenance.source === 'agent'`, token usage flows into action
 *   metadata, empty source short-circuits without calling the LLM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks (must come before runner import) ─────────────────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: () => undefined,
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  isSpanContextValid: () => false,
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/observability/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: unknown, _name: string, fn: (span: unknown) => unknown) =>
    fn({ setAttribute: vi.fn() }),
}));

// Mock the LLM extractor so reflection tests don't need a live API key.
// Tests that exercise the `llm` path supply behaviour via
// `mockExtract.mockResolvedValueOnce(...)`.
const mockExtract = vi.fn<
  (
    extractor_agent_id: string,
    source: unknown,
    max_facts?: number,
    instruction?: string,
  ) => Promise<{ facts: string[]; reasoning?: string; tokensUsed: number }>
>();
vi.mock('../src/agents/executors/extractor/executor', () => ({
  extractFactsExecutor: (
    agentId: string,
    source: unknown,
    maxFacts?: number,
    instruction?: string,
  ) => mockExtract(agentId, source, maxFacts, instruction),
  DEFAULT_MAX_FACTS: 10,
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { executeReflectionNode } from '../src/execution/nodes/reflection.js';
import { ReflectionConfigSchema, GraphNodeSchema, NodeTypeSchema } from '../src/graph/graph.js';
import type { Graph, GraphNode, ReflectionConfig } from '../src/graph/graph.js';
import type { MemoryWriter, MemoryWriterFact } from '../src/memory/memory-writer.js';
import type { FactSanitizer } from '../src/security/fact-sanitizer.js';
import type { StateView } from '../src/state/state.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';
import { validateGraph } from '../src/graph/graph-validator.js';
import { NodeConfigError } from '../src/execution/errors.js';
import { MemoryWriterMissingError } from '../src/execution/nodes/errors.js';
import { createTestState, makeNode } from './helpers/factories.js';

// ─── Schema ─────────────────────────────────────────────────────────

describe('ReflectionConfigSchema', () => {
  it('accepts a minimal rule_based config', () => {
    const parsed = ReflectionConfigSchema.parse({
      source_keys: ['draft'],
      extractor: { type: 'rule_based' },
    });
    expect(parsed.extractor.type).toBe('rule_based');
    expect(parsed.tags).toEqual([]);
    expect(parsed.source_keys).toEqual(['draft']);
  });

  it('accepts a minimal llm config', () => {
    const parsed = ReflectionConfigSchema.parse({
      source_keys: ['draft', 'review'],
      extractor: { type: 'llm', agent_id: 'reflector-1' },
      tags: ['lesson', 'graph:research-v1'],
      entity_keys: ['target_entity'],
      result_key: 'my_result',
    });
    expect(parsed.extractor).toEqual({ type: 'llm', agent_id: 'reflector-1', max_facts: 10 });
    expect(parsed.tags).toEqual(['lesson', 'graph:research-v1']);
    expect(parsed.entity_keys).toEqual(['target_entity']);
    expect(parsed.result_key).toBe('my_result');
  });

  it('rejects empty source_keys', () => {
    expect(() =>
      ReflectionConfigSchema.parse({
        source_keys: [],
        extractor: { type: 'rule_based' },
      }),
    ).toThrow();
  });

  it('rejects an llm extractor without agent_id', () => {
    expect(() =>
      ReflectionConfigSchema.parse({
        source_keys: ['draft'],
        extractor: { type: 'llm' },
      }),
    ).toThrow();
  });

  it('rejects an unknown extractor type', () => {
    expect(() =>
      ReflectionConfigSchema.parse({
        source_keys: ['draft'],
        extractor: { type: 'magic' },
      }),
    ).toThrow();
  });
});

describe('NodeTypeSchema', () => {
  it('includes "reflection"', () => {
    expect(NodeTypeSchema.parse('reflection')).toBe('reflection');
  });
});

describe('GraphNodeSchema', () => {
  it('parses a reflection node with reflection_config', () => {
    const node = GraphNodeSchema.parse({
      id: 'reflect',
      type: 'reflection',
      read_keys: ['draft'],
      write_keys: ['reflect_reflection'],
      reflection_config: {
        source_keys: ['draft'],
        extractor: { type: 'rule_based' },
        tags: ['lesson'],
      },
    });
    expect(node.type).toBe('reflection');
    expect(node.reflection_config?.tags).toEqual(['lesson']);
  });
});

// ─── Validator ──────────────────────────────────────────────────────

describe('validateGraph — reflection', () => {
  const baseEdges = [{ id: 'e1', source: 'start', target: 'reflect', condition: { type: 'always' as const } }];

  const makeReflectionGraph = (overrides: Partial<Parameters<typeof makeNode>[0]> = {}): Graph => ({
    id: uuidv4(),
    name: 'Reflection Test',
    description: 'For validator tests',
    nodes: [
      makeNode({ id: 'start', agent_id: 'agent-1' }),
      makeNode({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: ['draft'],
        write_keys: ['reflect_reflection'],
        reflection_config: {
          source_keys: ['draft'],
          extractor: { type: 'rule_based', min_sentence_length: 15 },
          tags: ['lesson'],
        },
        ...overrides,
      }),
    ],
    edges: baseEdges,
    start_node: 'start',
    end_nodes: ['reflect'],
    strict_taint: false,
  });

  it('passes for a well-formed reflection node', () => {
    const result = validateGraph(makeReflectionGraph());
    expect(result.errors).toEqual([]);
  });

  it('errors when reflection_config is missing', () => {
    const graph = makeReflectionGraph({ reflection_config: undefined });
    const result = validateGraph(graph);
    expect(result.errors).toContain(`Reflection node 'reflect' is missing reflection_config`);
  });

  it('errors when source_keys are not declared in read_keys', () => {
    const graph = makeReflectionGraph({
      read_keys: ['something_else'],
      reflection_config: {
        source_keys: ['draft', 'missing'],
        extractor: { type: 'rule_based', min_sentence_length: 15 },
        tags: ['lesson'],
      },
    });
    const result = validateGraph(graph);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        `Reflection node 'reflect': source_key 'draft' not in read_keys`,
        `Reflection node 'reflect': source_key 'missing' not in read_keys`,
      ]),
    );
  });

  it('errors when entity_keys are not in read_keys', () => {
    const graph = makeReflectionGraph({
      read_keys: ['draft'],
      reflection_config: {
        source_keys: ['draft'],
        entity_keys: ['target_entity'],
        extractor: { type: 'rule_based', min_sentence_length: 15 },
        tags: ['lesson'],
      },
    });
    const result = validateGraph(graph);
    expect(result.errors).toContain(
      `Reflection node 'reflect': entity_key 'target_entity' not in read_keys`,
    );
  });

  it('skips read_keys checks under wildcard', () => {
    const graph = makeReflectionGraph({
      read_keys: ['*'],
      reflection_config: {
        source_keys: ['anything', 'else'],
        entity_keys: ['ok'],
        extractor: { type: 'rule_based', min_sentence_length: 15 },
        tags: ['lesson'],
      },
    });
    const result = validateGraph(graph);
    expect(result.errors).toEqual([]);
  });

  it('warns when tags are empty', () => {
    const graph = makeReflectionGraph({
      reflection_config: {
        source_keys: ['draft'],
        extractor: { type: 'rule_based', min_sentence_length: 15 },
        tags: [],
      },
    });
    const result = validateGraph(graph);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Reflection node 'reflect': no tags set`),
      ]),
    );
  });
});

// ─── Runner dispatch ────────────────────────────────────────────────

function makeReflectGraph(): Graph {
  return {
    id: uuidv4(),
    name: 'reflect-graph',
    description: 'single reflection node',
    nodes: [
      makeNode({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: ['draft'],
        write_keys: ['reflect_reflection'],
        reflection_config: {
          source_keys: ['draft'],
          extractor: { type: 'rule_based', min_sentence_length: 15 },
          tags: ['lesson'],
        },
        failure_policy: {
          max_retries: 1,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1,
          max_backoff_ms: 10,
        },
      }),
    ],
    edges: [],
    start_node: 'reflect',
    end_nodes: ['reflect'],
    strict_taint: false,
  };
}

describe('GraphRunner — reflection dispatch', () => {
  it('fails pre-flight when a reflection node has no memoryWriter (before any node runs)', async () => {
    const state = createTestState({ memory: { draft: 'some draft text' } });
    const runner = new GraphRunner(makeReflectGraph(), state);
    await expect(runner.run()).rejects.toThrow(/memoryWriter/);
  });

  it('fails pre-flight when a node declares MCP tools but no resolver is wired', async () => {
    const graph: Graph = {
      id: uuidv4(),
      name: 'mcp-graph',
      description: 'agent node with mcp tools',
      nodes: [
        makeNode({
          id: 'researcher',
          type: 'agent',
          agent_id: uuidv4(),
          read_keys: ['goal'],
          write_keys: ['notes'],
          tools: [{ type: 'mcp', server_id: 'web-search' }],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
        }),
      ],
      edges: [],
      start_node: 'researcher',
      end_nodes: ['researcher'],
      strict_taint: false,
    };
    const runner = new GraphRunner(graph, createTestState({ memory: { goal: 'x' } }));
    await expect(runner.run()).rejects.toThrow(/ToolResolver/);
  });
});

// ─── rule_based extractor ───────────────────────────────────────────

describe('rule_based reflection extractor', () => {
  const drafty = [
    'Use academic sources for primary research.',
    'Avoid Wikipedia for citations.',
    'Check the publication date before quoting numbers.',
  ].join(' ');

  it('extracts one fact per sentence and persists via memoryWriter', async () => {
    const fact_ids = ['f1', 'f2', 'f3'];
    const memoryWriter = vi.fn<MemoryWriter>(async () => ({ fact_ids }));

    const state = createTestState({ memory: { draft: drafty } });
    const finalState = await new GraphRunner(makeReflectGraph(), state, { memoryWriter }).run();

    expect(memoryWriter).toHaveBeenCalledTimes(1);
    const [calledFacts] = memoryWriter.mock.calls[0];
    expect(calledFacts).toHaveLength(3);
    expect(calledFacts.map((f) => f.content)).toEqual([
      'Use academic sources for primary research.',
      'Avoid Wikipedia for citations.',
      'Check the publication date before quoting numbers.',
    ]);

    for (const fact of calledFacts) {
      expect(fact.tags).toEqual(['lesson']);
      expect(fact.provenance.source).toBe('derived');
      expect(fact.provenance.node_id).toBe('reflect');
      expect(fact.provenance.workflow_id).toBe(state.workflow_id);
      expect(fact.provenance.run_id).toBe(state.run_id);
      expect(fact.entities).toBeUndefined();
    }

    const envelope = finalState.memory.reflect_reflection as {
      extractor_type: string;
      fact_ids: string[];
      tags: string[];
      reflected_at: string;
    };
    expect(envelope.extractor_type).toBe('rule_based');
    expect(envelope.fact_ids).toEqual(fact_ids);
    expect(envelope.tags).toEqual(['lesson']);
    expect(typeof envelope.reflected_at).toBe('string');
  });

  it('filters sentences below min_sentence_length and dedupes case-insensitively', async () => {
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `id-${i}`),
    }));

    const draft = [
      'Tiny.',
      'Cite the original source carefully.',
      'cite   the   original   source carefully.',
      'Avoid Wikipedia for citations.',
    ].join(' ');

    const state = createTestState({ memory: { draft } });
    await new GraphRunner(makeReflectGraph(), state, { memoryWriter }).run();

    const [facts] = memoryWriter.mock.calls[0];
    expect(facts.map((f) => f.content)).toEqual([
      'Cite the original source carefully.',
      'Avoid Wikipedia for citations.',
    ]);
  });

  it('concatenates multiple source_keys', async () => {
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `id-${i}`),
    }));

    const graph = makeReflectGraph();
    graph.nodes[0].read_keys = ['draft', 'review'];
    graph.nodes[0].reflection_config = {
      source_keys: ['draft', 'review'],
      extractor: { type: 'rule_based', min_sentence_length: 15 },
      tags: ['lesson'],
    };

    const state = createTestState({
      memory: {
        draft: 'Use academic sources for primary research.',
        review: 'Always sanity-check the publication date.',
      },
    });

    await new GraphRunner(graph, state, { memoryWriter }).run();

    const [facts] = memoryWriter.mock.calls[0];
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.content).sort()).toEqual([
      'Always sanity-check the publication date.',
      'Use academic sources for primary research.',
    ]);
  });

  it('attaches entities from entity_keys onto every fact', async () => {
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `id-${i}`),
    }));

    const graph = makeReflectGraph();
    graph.nodes[0].read_keys = ['draft', 'topic'];
    graph.nodes[0].reflection_config = {
      source_keys: ['draft'],
      entity_keys: ['topic'],
      extractor: { type: 'rule_based', min_sentence_length: 15 },
      tags: ['lesson', 'graph:research-v1'],
    };

    const state = createTestState({
      memory: {
        draft: 'Use academic sources for primary research.',
        topic: 'quantum computing',
      },
    });

    await new GraphRunner(graph, state, { memoryWriter }).run();

    const [facts] = memoryWriter.mock.calls[0];
    expect(facts).toHaveLength(1);
    expect(facts[0].entities).toEqual([{ name: 'quantum computing', type: 'concept' }]);
    expect(facts[0].tags).toEqual(['lesson', 'graph:research-v1']);
  });

  it('skips the writer when nothing extractable is in source', async () => {
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `id-${i}`),
    }));

    const state = createTestState({ memory: { draft: 'tiny. nope.' } });
    const finalState = await new GraphRunner(makeReflectGraph(), state, { memoryWriter }).run();

    expect(memoryWriter).not.toHaveBeenCalled();
    const envelope = finalState.memory.reflect_reflection as { fact_ids: string[] };
    expect(envelope.fact_ids).toEqual([]);
  });

  it('honours a custom result_key', async () => {
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `id-${i}`),
    }));

    const graph = makeReflectGraph();
    graph.nodes[0].write_keys = ['my_custom_key'];
    graph.nodes[0].reflection_config = {
      source_keys: ['draft'],
      extractor: { type: 'rule_based', min_sentence_length: 15 },
      tags: ['lesson'],
      result_key: 'my_custom_key',
    };

    const state = createTestState({ memory: { draft: 'Use academic sources for primary research.' } });
    const finalState = await new GraphRunner(graph, state, { memoryWriter }).run();

    expect(finalState.memory.my_custom_key).toBeDefined();
    expect(finalState.memory.reflect_reflection).toBeUndefined();
  });
});

// ─── llm extractor ──────────────────────────────────────────────────

function makeLLMReflectGraph(overrides: {
  agent_id?: string;
  instruction?: string;
  max_facts?: number;
  entity_keys?: string[];
  read_keys?: string[];
} = {}): Graph {
  return {
    id: uuidv4(),
    name: 'reflect-llm',
    description: 'single reflection node, llm extractor',
    nodes: [
      makeNode({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: overrides.read_keys ?? ['draft'],
        write_keys: ['reflect_reflection'],
        reflection_config: {
          source_keys: ['draft'],
          entity_keys: overrides.entity_keys,
          extractor: {
            type: 'llm',
            agent_id: overrides.agent_id ?? 'reflector-agent',
            instruction: overrides.instruction,
            max_facts: overrides.max_facts ?? 10,
          },
          tags: ['lesson', 'graph:research-v1'],
        },
        failure_policy: {
          max_retries: 1,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1,
          max_backoff_ms: 10,
        },
      }),
    ],
    edges: [],
    start_node: 'reflect',
    end_nodes: ['reflect'],
    strict_taint: false,
  };
}

describe('llm reflection extractor', () => {
  beforeEach(() => {
    mockExtract.mockReset();
  });

  it('calls extractFactsExecutor with the configured agent_id, source corpus, max_facts, and instruction', async () => {
    mockExtract.mockResolvedValueOnce({
      facts: ['Prefer primary sources to summaries.', 'Cite the publication date.'],
      tokensUsed: 1337,
    });
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `f-${i}`),
    }));

    const graph = makeLLMReflectGraph({
      agent_id: 'reflector-7',
      instruction: 'Extract methodology lessons only.',
      max_facts: 4,
    });
    const state = createTestState({
      memory: { draft: 'Use peer-reviewed journals. Avoid Wikipedia citations.' },
    });

    await new GraphRunner(graph, state, { memoryWriter }).run();

    expect(mockExtract).toHaveBeenCalledTimes(1);
    const [agentId, source, maxFacts, instruction] = mockExtract.mock.calls[0];
    expect(agentId).toBe('reflector-7');
    expect(source).toContain('Use peer-reviewed journals');
    expect(maxFacts).toBe(4);
    expect(instruction).toBe('Extract methodology lessons only.');
  });

  it('persists each returned fact with provenance.source="agent" and configured tags', async () => {
    mockExtract.mockResolvedValueOnce({
      facts: ['Prefer primary sources.', 'Cite the publication date.'],
      tokensUsed: 800,
    });
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `f-${i}`),
    }));

    const state = createTestState({ memory: { draft: 'some draft' } });
    await new GraphRunner(makeLLMReflectGraph(), state, { memoryWriter }).run();

    expect(memoryWriter).toHaveBeenCalledTimes(1);
    const [facts] = memoryWriter.mock.calls[0];
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.content)).toEqual([
      'Prefer primary sources.',
      'Cite the publication date.',
    ]);
    for (const fact of facts) {
      expect(fact.tags).toEqual(['lesson', 'graph:research-v1']);
      expect(fact.provenance.source).toBe('agent');
      expect(fact.provenance.node_id).toBe('reflect');
      expect(fact.provenance.workflow_id).toBe(state.workflow_id);
    }
  });

  it('attaches entities from entity_keys onto every llm-extracted fact', async () => {
    mockExtract.mockResolvedValueOnce({
      facts: ['One lesson.', 'Another lesson.'],
      tokensUsed: 500,
    });
    const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({
      fact_ids: facts.map((_, i) => `f-${i}`),
    }));

    const graph = makeLLMReflectGraph({
      read_keys: ['draft', 'topic'],
      entity_keys: ['topic'],
    });
    const state = createTestState({
      memory: { draft: 'some draft', topic: 'quantum computing' },
    });

    await new GraphRunner(graph, state, { memoryWriter }).run();

    const [facts] = memoryWriter.mock.calls[0];
    for (const fact of facts) {
      expect(fact.entities).toEqual([{ name: 'quantum computing', type: 'concept' }]);
    }
  });

  it('writes the ReflectionResult envelope and threads fact_ids back from the writer', async () => {
    mockExtract.mockResolvedValueOnce({
      facts: ['A.', 'A longer lesson worth keeping.'],
      tokensUsed: 250,
    });
    const memoryWriter = vi.fn<MemoryWriter>(async () => ({
      fact_ids: ['db-id-1', 'db-id-2'],
    }));

    const state = createTestState({ memory: { draft: 'some draft' } });
    const finalState = await new GraphRunner(makeLLMReflectGraph(), state, { memoryWriter }).run();

    const envelope = finalState.memory.reflect_reflection as {
      extractor_type: string;
      fact_ids: string[];
      tags: string[];
    };
    expect(envelope.extractor_type).toBe('llm');
    expect(envelope.fact_ids).toEqual(['db-id-1', 'db-id-2']);
    expect(envelope.tags).toEqual(['lesson', 'graph:research-v1']);
  });

  it('threads llm token usage into the workflow total', async () => {
    mockExtract.mockResolvedValueOnce({
      facts: ['One lesson.'],
      tokensUsed: 4242,
    });
    const memoryWriter = vi.fn<MemoryWriter>(async () => ({ fact_ids: ['f-0'] }));

    const state = createTestState({ memory: { draft: 'some draft' } });
    const finalState = await new GraphRunner(makeLLMReflectGraph(), state, { memoryWriter }).run();

    expect(finalState.total_tokens_used).toBeGreaterThanOrEqual(4242);
  });

  it('skips the LLM call and the writer when source is empty', async () => {
    const memoryWriter = vi.fn<MemoryWriter>(async () => ({ fact_ids: [] }));
    const state = createTestState({ memory: { draft: '   ' } });
    const finalState = await new GraphRunner(makeLLMReflectGraph(), state, { memoryWriter }).run();

    expect(mockExtract).not.toHaveBeenCalled();
    expect(memoryWriter).not.toHaveBeenCalled();
    const envelope = finalState.memory.reflect_reflection as { fact_ids: string[] };
    expect(envelope.fact_ids).toEqual([]);
  });

  it('does not call the writer when the llm returns zero facts', async () => {
    mockExtract.mockResolvedValueOnce({ facts: [], tokensUsed: 100 });
    const memoryWriter = vi.fn<MemoryWriter>(async () => ({ fact_ids: [] }));

    const state = createTestState({ memory: { draft: 'some draft' } });
    const finalState = await new GraphRunner(makeLLMReflectGraph(), state, { memoryWriter }).run();

    expect(memoryWriter).not.toHaveBeenCalled();
    const envelope = finalState.memory.reflect_reflection as { fact_ids: string[] };
    expect(envelope.fact_ids).toEqual([]);
  });
});

// ─── executeReflectionNode — direct (config, sanitizer, helper branches) ──

function makeReflectionNode(config: ReflectionConfig | undefined): GraphNode {
  return makeNode({
    id: 'reflect',
    type: 'reflection',
    agent_id: undefined,
    read_keys: ['*'],
    write_keys: ['reflect_reflection'],
    ...(config ? { reflection_config: config } : {}),
  });
}

function makeReflectStateView(memory: Record<string, unknown>): StateView {
  return {
    workflow_id: 'wf-reflect',
    run_id: 'run-reflect',
    goal: 'reflect',
    constraints: [],
    memory,
  };
}

function makeReflectCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    state: { iteration_count: 0 } as never,
    graph: { id: 'graph-reflect' } as never,
    createStateView: () => makeReflectStateView({}),
    deps: {
      extractFactsExecutor: vi.fn(),
    } as never,
    memoryWriter: vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) })),
    ...overrides,
  } as NodeExecutorContext;
}

describe('executeReflectionNode', () => {
  it('throws NodeConfigError when reflection_config is missing', async () => {
    await expect(
      executeReflectionNode(makeReflectionNode(undefined), makeReflectStateView({}), 1, makeReflectCtx()),
    ).rejects.toBeInstanceOf(NodeConfigError);
  });

  it('throws MemoryWriterMissingError when no memoryWriter is injected', async () => {
    const node = makeReflectionNode({ source_keys: ['draft'], extractor: { type: 'rule_based', min_sentence_length: 15 }, tags: ['lesson'] });

    await expect(
      executeReflectionNode(node, makeReflectStateView({ draft: 'x' }), 1, makeReflectCtx({ memoryWriter: undefined })),
    ).rejects.toBeInstanceOf(MemoryWriterMissingError);
  });

  describe('factSanitizer', () => {
    const node = makeReflectionNode({ source_keys: ['draft'], extractor: { type: 'rule_based', min_sentence_length: 15 }, tags: ['lesson'] });
    const draft = 'Cite the original source carefully. Avoid Wikipedia for citations.';

    it('drops a fact when the sanitizer returns null', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const factSanitizer: FactSanitizer = (fact) => (fact.content.includes('Wikipedia') ? null : fact);

      await executeReflectionNode(node, makeReflectStateView({ draft }), 1, makeReflectCtx({ memoryWriter, factSanitizer }));

      const [written] = memoryWriter.mock.calls[0];
      expect(written.map((f) => f.content)).toEqual(['Cite the original source carefully.']);
    });

    it('drops a fact when the sanitizer throws under the default fail-closed mode', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const factSanitizer: FactSanitizer = (fact) => {
        if (fact.content.includes('Wikipedia')) throw new Error('PII service down');
        return fact;
      };

      await executeReflectionNode(node, makeReflectStateView({ draft }), 1, makeReflectCtx({ memoryWriter, factSanitizer }));

      const [written] = memoryWriter.mock.calls[0];
      expect(written.map((f) => f.content)).toEqual(['Cite the original source carefully.']);
    });

    it('keeps the original fact when the sanitizer throws under fail-open mode', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const factSanitizer: FactSanitizer = () => { throw new Error('PII service down'); };

      await executeReflectionNode(
        node,
        makeReflectStateView({ draft }),
        1,
        makeReflectCtx({ memoryWriter, factSanitizer, factSanitizerFailMode: 'pass' }),
      );

      const [written] = memoryWriter.mock.calls[0];
      expect(written.map((f) => f.content)).toEqual([
        'Cite the original source carefully.',
        'Avoid Wikipedia for citations.',
      ]);
    });

    it('drops on a non-Error throw under fail-closed mode', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const factSanitizer: FactSanitizer = () => { throw 'bare string failure'; };

      await executeReflectionNode(node, makeReflectStateView({ draft }), 1, makeReflectCtx({ memoryWriter, factSanitizer }));

      expect(memoryWriter).not.toHaveBeenCalled();
    });

    it('keeps facts on a non-Error throw under fail-open mode', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const factSanitizer: FactSanitizer = () => { throw 'bare string failure'; };

      await executeReflectionNode(
        node,
        makeReflectStateView({ draft }),
        1,
        makeReflectCtx({ memoryWriter, factSanitizer, factSanitizerFailMode: 'pass' }),
      );

      const [written] = memoryWriter.mock.calls[0];
      expect(written).toHaveLength(2);
    });

    it('does not call the writer when the sanitizer drops every rule-based fact', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async () => ({ fact_ids: ['unexpected'] }));
      const factSanitizer: FactSanitizer = () => null;

      const action = await executeReflectionNode(node, makeReflectStateView({ draft }), 1, makeReflectCtx({ memoryWriter, factSanitizer }));

      expect(memoryWriter).not.toHaveBeenCalled();
      const envelope = action.payload.updates.reflect_reflection as { fact_ids: string[] };
      expect(envelope.fact_ids).toEqual([]);
    });

    it('does not call the writer when the sanitizer drops every llm-extracted fact', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async () => ({ fact_ids: ['unexpected'] }));
      const extractFactsExecutor = vi.fn().mockResolvedValue({ facts: ['Drop me.', 'And me.'], tokensUsed: 42 });
      const factSanitizer: FactSanitizer = () => null;
      const llmNode = makeReflectionNode({
        source_keys: ['draft'],
        extractor: { type: 'llm', agent_id: 'reflector', max_facts: 5 },
        tags: ['lesson'],
      });

      const action = await executeReflectionNode(
        llmNode,
        makeReflectStateView({ draft: 'some corpus' }),
        1,
        makeReflectCtx({ memoryWriter, factSanitizer, deps: { extractFactsExecutor } as never }),
      );

      expect(memoryWriter).not.toHaveBeenCalled();
      const envelope = action.payload.updates.reflect_reflection as { fact_ids: string[] };
      expect(envelope.fact_ids).toEqual([]);
      expect(action.metadata.token_usage?.totalTokens).toBe(42);
    });
  });

  describe('source concatenation and helpers', () => {
    it('skips absent source keys and stringifies non-string values', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const node = makeReflectionNode({
        source_keys: ['present', 'absent'],
        extractor: { type: 'rule_based', min_sentence_length: 5 },
        tags: ['lesson'],
      });

      await executeReflectionNode(
        node,
        makeReflectStateView({ present: { summary: 'A durable structured lesson worth keeping around.' } }),
        1,
        makeReflectCtx({ memoryWriter }),
      );

      const [written] = memoryWriter.mock.calls[0];
      expect(written[0].content).toContain('durable structured lesson');
    });

    it('falls back to String() when a source value is not JSON-serialisable', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const node = makeReflectionNode({
        source_keys: ['circular'],
        extractor: { type: 'rule_based', min_sentence_length: 5 },
        tags: ['lesson'],
      });

      await executeReflectionNode(node, makeReflectStateView({ circular }), 1, makeReflectCtx({ memoryWriter }));

      const [written] = memoryWriter.mock.calls[0] as [MemoryWriterFact[]];
      expect(written[0].content).toContain('object Object');
    });

    it('extracts no facts when every source key is absent (empty corpus)', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async () => ({ fact_ids: [] }));
      const node = makeReflectionNode({
        source_keys: ['nothing_here'],
        extractor: { type: 'rule_based', min_sentence_length: 5 },
        tags: ['lesson'],
      });

      const action = await executeReflectionNode(node, makeReflectStateView({}), 1, makeReflectCtx({ memoryWriter }));

      expect(memoryWriter).not.toHaveBeenCalled();
      const envelope = action.payload.updates.reflect_reflection as { fact_ids: string[] };
      expect(envelope.fact_ids).toEqual([]);
    });
  });

  describe('entity references', () => {
    it('attaches only string, non-empty entity_keys and omits entities entirely when none qualify', async () => {
      const memoryWriter = vi.fn<MemoryWriter>(async (facts) => ({ fact_ids: facts.map((_, i) => `id-${i}`) }));
      const node = makeReflectionNode({
        source_keys: ['draft'],
        entity_keys: ['blank', 'numeric'],
        extractor: { type: 'rule_based', min_sentence_length: 15 },
        tags: ['lesson'],
      });

      await executeReflectionNode(
        node,
        makeReflectStateView({ draft: 'Cite the original source carefully.', blank: '   ', numeric: 42 }),
        1,
        makeReflectCtx({ memoryWriter }),
      );

      const [written] = memoryWriter.mock.calls[0] as [MemoryWriterFact[]];
      expect(written[0].entities).toBeUndefined();
    });
  });
});

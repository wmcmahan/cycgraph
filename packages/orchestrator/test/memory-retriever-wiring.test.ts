/**
 * memoryRetriever → buildSystemPrompt wiring tests.
 *
 * Until this wiring landed, `memoryRetriever` was plumbed through
 * `GraphRunnerOptions → NodeExecutorContext` but no executor consumed
 * it. These tests pin the new behaviour:
 *
 * - `buildSystemPrompt` renders a `## Relevant Memory` section when
 *   `retrievedMemory` is non-empty, omits it otherwise.
 * - End-to-end: an agent node with `memory_query` set causes the
 *   injected `memoryRetriever` to fire with the right shape, and the
 *   facts it returns appear in the prompt the LLM sees.
 * - Retriever failures are absorbed (best-effort) — the prompt still
 *   builds and the workflow still runs.
 * - Defaulting: a `memory_query: {}` falls back to `text: stateView.goal`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { buildSystemPrompt } from '../src/agent/agent-executor/prompts.js';
import type { AgentConfig } from '../src/agent/types.js';
import type { StateView } from '../src/types/state.js';
import type {
  MemoryRetriever,
  MemoryRetrievalResult,
} from '../src/agent/memory-retriever.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'test-agent',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system: 'You are a test agent.',
    temperature: 0.7,
    maxSteps: 10,
    write_keys: ['results'],
    read_keys: ['*'],
    tools: [],
    ...overrides,
  } as AgentConfig;
}

function makeStateView(memory?: Record<string, unknown>): StateView {
  return {
    workflow_id: 'wf-test',
    run_id: 'run-test',
    goal: 'Test goal',
    constraints: ['Be concise'],
    memory: memory ?? {},
  };
}

// ─── Unit: renderRetrievedMemory via buildSystemPrompt ──────────────

describe('buildSystemPrompt — Relevant Memory section', () => {
  it('omits the section when retrievedMemory is undefined', () => {
    const prompt = buildSystemPrompt(makeConfig(), makeStateView());
    expect(prompt).not.toContain('Relevant Memory');
    expect(prompt).not.toContain('<memory>');
  });

  it('omits the section when retrievedMemory is null', () => {
    const prompt = buildSystemPrompt(makeConfig(), makeStateView(), {
      retrievedMemory: null,
    });
    expect(prompt).not.toContain('Relevant Memory');
  });

  it('omits the section when retrievedMemory has no facts/entities/themes', () => {
    const prompt = buildSystemPrompt(makeConfig(), makeStateView(), {
      retrievedMemory: { facts: [], entities: [], themes: [] },
    });
    expect(prompt).not.toContain('Relevant Memory');
    expect(prompt).not.toContain('<memory>');
  });

  it('renders facts as bullet points inside <memory> boundary tags', () => {
    const retrievedMemory: MemoryRetrievalResult = {
      facts: [
        { content: 'Cite primary sources.', validFrom: new Date() },
        { content: 'Avoid Wikipedia for citations.', validFrom: new Date() },
      ],
      entities: [],
      themes: [],
    };
    const prompt = buildSystemPrompt(makeConfig(), makeStateView(), {
      retrievedMemory,
    });
    expect(prompt).toContain('## Relevant Memory');
    expect(prompt).toContain('<memory>');
    expect(prompt).toContain('- Cite primary sources.');
    expect(prompt).toContain('- Avoid Wikipedia for citations.');
    expect(prompt).toContain('</memory>');
  });

  it('renders themes and entities when present', () => {
    const retrievedMemory: MemoryRetrievalResult = {
      facts: [{ content: 'A lesson.', validFrom: new Date() }],
      entities: [
        { name: 'quantum computing', type: 'concept' },
        { name: 'Alice', type: 'person' },
      ],
      themes: [{ label: 'Research Methodology' }],
    };
    const prompt = buildSystemPrompt(makeConfig(), makeStateView(), {
      retrievedMemory,
    });
    expect(prompt).toContain('Themes: Research Methodology');
    expect(prompt).toContain('quantum computing (concept)');
    expect(prompt).toContain('Alice (person)');
  });

  it('renders Relevant Memory before the Available Memory <data> block', () => {
    const retrievedMemory: MemoryRetrievalResult = {
      facts: [{ content: 'A lesson.', validFrom: new Date() }],
      entities: [],
      themes: [],
    };
    const prompt = buildSystemPrompt(makeConfig(), makeStateView(), {
      retrievedMemory,
    });
    const retrievedAt = prompt.indexOf('## Relevant Memory');
    const dataAt = prompt.indexOf('## Available Memory');
    expect(retrievedAt).toBeGreaterThan(-1);
    expect(dataAt).toBeGreaterThan(-1);
    expect(retrievedAt).toBeLessThan(dataAt);
  });
});

// ─── End-to-end: GraphRunner + memoryRetriever + memory_query ──────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

// Capture the system prompt the executor sees by spying on streamText.
const streamTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    streamText: (opts: unknown) => streamTextMock(opts),
    generateObject: vi.fn(),
    generateText: vi.fn(),
    tool: actual.tool,
    jsonSchema: actual.jsonSchema,
    stepCountIs: actual.stepCountIs,
    Output: actual.Output,
  };
});

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent',
      name: 'Test',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system: 'You are a test agent.',
      temperature: 0.7,
      maxSteps: 10,
      tools: [],
      read_keys: ['*'],
      write_keys: ['result'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: unknown, _name: string, fn: (span: unknown) => unknown) =>
    fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/runner/graph-runner.js';
import type { Graph } from '../src/types/graph.js';
import { createTestState, makeNode } from './helpers/factories.js';
import { getLessonProvenance, getInjectedFactIds } from '../src/utils/lesson-provenance.js';

function makeAgentGraph(memory_query: Graph['nodes'][number]['memory_query']): Graph {
  return {
    id: uuidv4(),
    name: 'agent-with-memory-query',
    description: 'single agent node carrying a memory_query directive',
    nodes: [
      makeNode({
        id: 'researcher',
        type: 'agent',
        agent_id: 'test-agent',
        read_keys: ['goal', 'constraints'],
        write_keys: ['result'],
        memory_query,
        failure_policy: {
          max_retries: 1,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1,
          max_backoff_ms: 10,
        },
      }),
    ],
    edges: [],
    start_node: 'researcher',
    end_nodes: ['researcher'],
    strict_taint: false,
  };
}

function stubStreamText(text: string) {
  streamTextMock.mockReturnValue({
    text: Promise.resolve(text),
    textStream: (async function* () {
      yield text;
    })(),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    steps: Promise.resolve([{}]),
  });
}

describe('GraphRunner — memoryRetriever + memory_query', () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  it('calls memoryRetriever with the configured query and renders facts into the system prompt', async () => {
    stubStreamText('done');

    const memoryRetriever: MemoryRetriever = vi.fn(async () => ({
      facts: [{ content: 'Prefer primary sources.', validFrom: new Date() }],
      entities: [],
      themes: [],
    }));

    const graph = makeAgentGraph({ tags: ['graph:research-v1'], max_facts: 5 });
    const state = createTestState({ goal: 'Research X', memory: {} });

    await new GraphRunner(graph, state, { memoryRetriever }).run();

    expect(memoryRetriever).toHaveBeenCalledTimes(1);
    const [query, options] = (memoryRetriever as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(query.tags).toEqual(['graph:research-v1']);
    // No text/entityIds set → runtime should NOT fall back to goal because
    // tags-only is a valid query shape on its own.
    expect(query.text).toBeUndefined();
    expect(query.entityIds).toBeUndefined();
    expect(options.maxFacts).toBe(5);

    // The system prompt that streamText saw should contain the retrieved fact.
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const sysPrompt = streamTextMock.mock.calls[0][0].system as string;
    expect(sysPrompt).toContain('## Relevant Memory');
    expect(sysPrompt).toContain('Prefer primary sources.');
  });

  it('defaults text to stateView.goal when memory_query is empty', async () => {
    stubStreamText('done');

    const memoryRetriever = vi.fn<MemoryRetriever>(async () => null);

    const graph = makeAgentGraph({});
    const state = createTestState({ goal: 'Research credibility', memory: {} });

    await new GraphRunner(graph, state, { memoryRetriever }).run();

    expect(memoryRetriever).toHaveBeenCalledTimes(1);
    const [query] = memoryRetriever.mock.calls[0];
    expect(query.text).toBe('Research credibility');
  });

  it('does not call the retriever when memory_query is absent', async () => {
    stubStreamText('done');

    const memoryRetriever = vi.fn<MemoryRetriever>(async () => null);

    // No memory_query on the node
    const graph = makeAgentGraph(undefined);
    const state = createTestState({ goal: 'Research X', memory: {} });

    await new GraphRunner(graph, state, { memoryRetriever }).run();

    expect(memoryRetriever).not.toHaveBeenCalled();

    const sysPrompt = streamTextMock.mock.calls[0][0].system as string;
    expect(sysPrompt).not.toContain('## Relevant Memory');
  });

  it('absorbs retriever errors — prompt still builds, workflow still runs', async () => {
    stubStreamText('done');

    const memoryRetriever = vi.fn<MemoryRetriever>(async () => {
      throw new Error('store unavailable');
    });

    const graph = makeAgentGraph({ tags: ['graph:research-v1'] });
    const state = createTestState({ goal: 'Research X', memory: {} });

    const finalState = await new GraphRunner(graph, state, { memoryRetriever }).run();

    expect(finalState.status).toBe('completed');
    expect(memoryRetriever).toHaveBeenCalledTimes(1);
    const sysPrompt = streamTextMock.mock.calls[0][0].system as string;
    expect(sysPrompt).not.toContain('## Relevant Memory');
  });
});

// ─── Lesson provenance: retrieved fact ids → _lesson_provenance ─────

describe('GraphRunner — lesson provenance recording', () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  it('records injected fact ids in _lesson_provenance when the retriever supplies them', async () => {
    stubStreamText('done');

    const memoryRetriever: MemoryRetriever = vi.fn(async () => ({
      facts: [
        { content: 'Prefer primary sources.', validFrom: new Date(), id: 'fact-1' },
        { content: 'Quantify claims.', validFrom: new Date(), id: 'fact-2' },
        // No id — not attributable, must be skipped without error.
        { content: 'Legacy lesson.', validFrom: new Date() },
      ],
      entities: [],
      themes: [],
    }));

    const graph = makeAgentGraph({ tags: ['graph:research-v1'] });
    const state = createTestState({ goal: 'Research X', memory: {} });

    const finalState = await new GraphRunner(graph, state, { memoryRetriever }).run();

    expect(finalState.status).toBe('completed');
    const entries = getLessonProvenance(finalState);
    expect(entries).toHaveLength(1);
    expect(entries[0].node_id).toBe('researcher');
    expect(entries[0].fact_ids).toEqual(['fact-1', 'fact-2']);
    expect(getInjectedFactIds(finalState)).toEqual(['fact-1', 'fact-2']);
  });

  it('records no provenance when retrieved facts carry no ids', async () => {
    stubStreamText('done');

    const memoryRetriever: MemoryRetriever = vi.fn(async () => ({
      facts: [{ content: 'Prefer primary sources.', validFrom: new Date() }],
      entities: [],
      themes: [],
    }));

    const graph = makeAgentGraph({ tags: ['graph:research-v1'] });
    const state = createTestState({ goal: 'Research X', memory: {} });

    const finalState = await new GraphRunner(graph, state, { memoryRetriever }).run();

    expect(getLessonProvenance(finalState)).toEqual([]);
    expect('_lesson_provenance' in finalState.memory).toBe(false);
  });

  it('records no provenance when there is no retriever or no memory_query', async () => {
    stubStreamText('done');

    const graph = makeAgentGraph(undefined);
    const state = createTestState({ goal: 'Research X', memory: {} });

    const finalState = await new GraphRunner(graph, state, {}).run();
    expect(getLessonProvenance(finalState)).toEqual([]);
  });
});

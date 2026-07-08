import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn().mockReturnValue({}) },
}));

// Mock agent factory
vi.mock('../src/agent/agent-factory/index', () => ({
  agentFactory: {
    loadAgent: vi.fn(),
    getModel: vi.fn(() => ({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' })),
  },
}));

// Mock logger to silence output
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { generateText } from 'ai';
import { agentFactory } from '../src/agent/agent-factory/index.js';
import { generateWorkflow } from '../src/architect/index.js';
import { ArchitectError } from '../src/architect/errors.js';
import { LLMGraphSchema } from '../src/architect/schemas.js';
import type { Graph } from '../src/types/graph.js';

// ─── Fixtures ─────────────────────────────────────────────────

/** A valid LLM graph output (linear: research → writer) */
function makeValidLLMGraph(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Research & Write',
    description: 'A research and writing pipeline',
    nodes: [
      {
        id: 'research',
        type: 'agent',
        agent_id: 'research-agent',
        read_keys: ['*'],
        write_keys: ['notes'],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      },
      {
        id: 'writer',
        type: 'agent',
        agent_id: 'writer-agent',
        read_keys: ['*'],
        write_keys: ['draft'],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      },
    ],
    edges: [
      { id: 'e1', source: 'research', target: 'writer', condition: { type: 'always' } },
    ],
    start_node: 'research',
    end_nodes: ['writer'],
    ...overrides,
  };
}

/** An invalid LLM graph (missing start node) */
function makeInvalidLLMGraph() {
  return makeValidLLMGraph({
    start_node: 'nonexistent',
  });
}

/** A supervisor-pattern LLM graph */
function makeSupervisorLLMGraph() {
  return {
    name: 'Content Pipeline',
    description: 'Supervisor-driven content pipeline',
    nodes: [
      {
        id: 'supervisor',
        type: 'supervisor',
        supervisor_config: {
          agent_id: 'router-agent',
          managed_nodes: ['research', 'writer'],
          max_iterations: 10,
        },
        read_keys: ['*'],
        write_keys: [],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      },
      {
        id: 'research',
        type: 'agent',
        agent_id: 'research-agent',
        read_keys: ['*'],
        write_keys: ['research_results'],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      },
      {
        id: 'writer',
        type: 'agent',
        agent_id: 'writer-agent',
        read_keys: ['*'],
        write_keys: ['draft'],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      },
    ],
    edges: [
      { id: 'e1', source: 'supervisor', target: 'research', condition: { type: 'always' } },
      { id: 'e2', source: 'supervisor', target: 'writer', condition: { type: 'always' } },
      { id: 'e3', source: 'research', target: 'supervisor', condition: { type: 'always' } },
      { id: 'e4', source: 'writer', target: 'supervisor', condition: { type: 'always' } },
    ],
    start_node: 'supervisor',
    end_nodes: [],
  };
}

/** A minimal existing graph (for modification tests) */
function makeExistingGraph(): Graph {
  return {
    id: 'existing-graph-id',
    name: 'Existing Graph',
    description: 'An existing graph to modify',
    nodes: [
      {
        id: 'research',
        type: 'agent',
        agent_id: 'research-agent',
        read_keys: ['*'],
        write_keys: ['notes'],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential' as const,
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      },
    ],
    edges: [],
    start_node: 'research',
    end_nodes: ['research'],
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe('generateWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (agentFactory.loadAgent as any).mockResolvedValue({
      id: 'architect-agent',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
  });

  it('generates a valid graph from a prompt', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    const result = await generateWorkflow({ prompt: 'Create a research and writing pipeline' });

    expect(result.graph.name).toBe('Research & Write');
    expect(result.graph.nodes).toHaveLength(2);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.start_node).toBe('research');
    expect(result.graph.end_nodes).toEqual(['writer']);
    expect(result.attempts).toBe(1);
    expect(result.is_modification).toBe(false);
  });

  it('assigns a UUID to the generated graph', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    const result = await generateWorkflow({ prompt: 'test' });

    expect(result.graph.id).toBeDefined();
    expect(result.graph.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not include timestamps (persistence-layer concerns)', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    const result = await generateWorkflow({ prompt: 'test' });

    expect((result.graph as any).created_at).toBeUndefined();
    expect((result.graph as any).updated_at).toBeUndefined();
  });

  it('loads agent config from factory with default architect-agent ID', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    await generateWorkflow({ prompt: 'test' });

    expect(agentFactory.loadAgent).toHaveBeenCalledWith('architect-agent');
  });

  it('uses custom architect_agent_id when provided', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    await generateWorkflow({ prompt: 'test', architectAgentId: 'custom-architect' });

    expect(agentFactory.loadAgent).toHaveBeenCalledWith('custom-architect');
  });

  it('calls generateText with low temperature for structured output', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    await generateWorkflow({ prompt: 'test' });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.3,
      })
    );
  });

  it('passes structured output config to generateText', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    await generateWorkflow({ prompt: 'test' });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.anything(),
      })
    );
  });

  it('returns raw LLM output alongside the converted graph', async () => {
    const llmGraph = makeValidLLMGraph();
    (generateText as any).mockResolvedValue({ output: llmGraph });

    const result = await generateWorkflow({ prompt: 'test' });

    expect(result.raw).toEqual(llmGraph);
  });

  it('generates a valid supervisor-pattern graph', async () => {
    (generateText as any).mockResolvedValue({ output: makeSupervisorLLMGraph() });

    const result = await generateWorkflow({ prompt: 'Create a supervised content pipeline' });

    expect(result.graph.nodes).toHaveLength(3);
    expect(result.graph.edges).toHaveLength(4);
    expect(result.graph.start_node).toBe('supervisor');
    expect(result.graph.end_nodes).toEqual([]);

    const supervisorNode = result.graph.nodes.find(n => n.id === 'supervisor');
    expect(supervisorNode?.type).toBe('supervisor');
    expect(supervisorNode?.supervisor_config?.managed_nodes).toEqual(['research', 'writer']);
  });

  // ─── Self-correction ───────────────────────────────────────

  it('self-corrects when first attempt produces invalid graph', async () => {
    // First call: invalid (bad start_node), second call: valid
    (generateText as any)
      .mockResolvedValueOnce({ output: makeInvalidLLMGraph() })
      .mockResolvedValueOnce({ output: makeValidLLMGraph() });

    const result = await generateWorkflow({ prompt: 'test' });

    expect(result.attempts).toBe(2);
    expect(result.graph.name).toBe('Research & Write');
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('includes validation errors in retry prompt', async () => {
    (generateText as any)
      .mockResolvedValueOnce({ output: makeInvalidLLMGraph() })
      .mockResolvedValueOnce({ output: makeValidLLMGraph() });

    await generateWorkflow({ prompt: 'test' });

    // Second call should include error feedback in the prompt
    const secondCall = (generateText as any).mock.calls[1][0];
    expect(secondCall.prompt).toContain('validation errors');
    expect(secondCall.prompt).toContain('nonexistent');
  });

  it('throws ArchitectError after max_retries exceeded', async () => {
    // All attempts return invalid graph
    (generateText as any).mockResolvedValue({ output: makeInvalidLLMGraph() });

    await expect(
      generateWorkflow({ prompt: 'test', maxRetries: 2 })
    ).rejects.toThrow(ArchitectError);
  });

  it('includes attempt count and last error in ArchitectError', async () => {
    (generateText as any).mockResolvedValue({ output: makeInvalidLLMGraph() });

    try {
      await generateWorkflow({ prompt: 'test', maxRetries: 1 });
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ArchitectError);
      expect((error as Error).message).toContain('2 attempts');
    }
  });

  it('handles generateObject throwing an error', async () => {
    (generateText as any).mockRejectedValue(new Error('API rate limit'));

    await expect(
      generateWorkflow({ prompt: 'test', maxRetries: 0 })
    ).rejects.toThrow(ArchitectError);
  });

  it('retries on generateObject errors', async () => {
    // First call: throws, second call: success
    (generateText as any)
      .mockRejectedValueOnce(new Error('Transient API error'))
      .mockResolvedValueOnce({ output: makeValidLLMGraph() });

    const result = await generateWorkflow({ prompt: 'test', maxRetries: 1 });

    expect(result.attempts).toBe(2);
    expect(result.graph.name).toBe('Research & Write');
  });

  // ─── Modification mode ─────────────────────────────────────

  it('preserves original graph ID in modification mode', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    const existing = makeExistingGraph();
    const result = await generateWorkflow({
      prompt: 'Add a writer node',
      currentGraph: existing,
    });

    expect(result.graph.id).toBe('existing-graph-id');
    expect(result.is_modification).toBe(true);
  });

  it('includes existing graph in modification mode prompt', async () => {
    (generateText as any).mockResolvedValue({ output: makeValidLLMGraph() });

    await generateWorkflow({
      prompt: 'Add a writer node',
      currentGraph: makeExistingGraph(),
    });

    const callArgs = (generateText as any).mock.calls[0][0];
    expect(callArgs.prompt).toContain('EXISTING workflow graph');
    expect(callArgs.prompt).toContain('research-agent');
    expect(callArgs.prompt).toContain('Add a writer node');
  });

  it('reports warnings from graph validation', async () => {
    // Graph with an unreachable node
    const llmGraph = makeValidLLMGraph();
    llmGraph.nodes.push({
      id: 'orphan',
      type: 'agent',
      agent_id: 'orphan-agent',
      read_keys: ['*'],
      write_keys: [],
      failure_policy: {
        max_retries: 3,
        backoff_strategy: 'exponential',
        initial_backoff_ms: 1000,
        max_backoff_ms: 60000,
      },
      requires_compensation: false,
    });
    (generateText as any).mockResolvedValue({ output: llmGraph });

    const result = await generateWorkflow({ prompt: 'test' });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('orphan'))).toBe(true);
  });
});

describe('LLMGraphSchema', () => {
  it('parses a valid linear graph', () => {
    const result = LLMGraphSchema.safeParse(makeValidLLMGraph());
    expect(result.success).toBe(true);
  });

  it('parses a valid supervisor graph', () => {
    const result = LLMGraphSchema.safeParse(makeSupervisorLLMGraph());
    expect(result.success).toBe(true);
  });

  it('applies default failure_policy values', () => {
    const minimal = {
      name: 'Minimal',
      description: 'Test',
      nodes: [{
        id: 'n1',
        type: 'agent',
        agent_id: 'test-agent',
      }],
      edges: [],
      start_node: 'n1',
      end_nodes: ['n1'],
    };

    const result = LLMGraphSchema.parse(minimal);
    const node = result.nodes[0];

    expect(node.failure_policy.max_retries).toBe(3);
    expect(node.failure_policy.backoff_strategy).toBe('exponential');
    // Least-privilege default — architect nodes must opt into memory reads.
    expect(node.read_keys).toEqual([]);
    expect(node.write_keys).toEqual([]);
    expect(node.requires_compensation).toBe(false);
  });

  it('rejects an unknown node type', () => {
    const invalid = makeValidLLMGraph();
    invalid.nodes[0].type = 'unknown_type' as any;

    const result = LLMGraphSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects graph with missing name', () => {
    const { name, ...noName } = makeValidLLMGraph();
    const result = LLMGraphSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });
});

describe('ArchitectError', () => {
  it('has correct name and message', () => {
    const err = new ArchitectError('generation failed');
    expect(err.name).toBe('ArchitectError');
    expect(err.message).toBe('generation failed');
    expect(err).toBeInstanceOf(Error);
  });
});

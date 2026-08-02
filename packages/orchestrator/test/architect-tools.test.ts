import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeArchitectTool,
  initArchitectTools,
  architectToolDefinitions,
  type ArchitectToolDeps,
} from '../src/architect/tools.js';
import { ArchitectError } from '../src/architect/errors.js';
import type { Graph } from '../src/types/graph.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock generateWorkflow
vi.mock('../src/architect/index.js', () => ({
  generateWorkflow: vi.fn().mockResolvedValue({
    graph: { id: 'g-1', name: 'Test Graph', nodes: [], edges: [], start_node: 'start' },
    is_modification: false,
    attempts: 1,
    warnings: [],
  }),
}));

// ─── Fixtures ────────────────────────────────────────────────────────

// A structurally + referentially valid minimal graph: one agent node that
// is both the start and the only end node. Publishing now validates, so
// fixtures must be real graphs.
function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    id: 'graph-1',
    name: 'Test Graph',
    description: 'A test graph',
    nodes: [
      {
        id: 'start',
        type: 'agent',
        agent_id: 'agent-1',
        read_keys: ['goal'],
        write_keys: ['result'],
      },
    ],
    edges: [],
    start_node: 'start',
    end_nodes: ['start'],
    ...overrides,
  } as unknown as Graph;
}

function makeDeps(overrides: Partial<ArchitectToolDeps> = {}): ArchitectToolDeps {
  return {
    saveGraph: vi.fn().mockResolvedValue(undefined),
    loadGraph: vi.fn().mockResolvedValue(null),
    allowUnguardedPublish: true,
    ...overrides,
  };
}

// ─── Tool Definitions ─────────────────────────────────────────────────

describe('architectToolDefinitions', () => {
  it('defines three tools', () => {
    expect(Object.keys(architectToolDefinitions)).toEqual([
      'architect_draft_workflow',
      'architect_publish_workflow',
      'architect_get_workflow',
    ]);
  });

  it('each tool has description and parameters', () => {
    for (const [_name, def] of Object.entries(architectToolDefinitions)) {
      expect(def.description).toBeTruthy();
      expect(def.parameters).toBeDefined();
    }
  });
});

// ─── executeArchitectTool ──────────────────────────────────────────────

describe('executeArchitectTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initArchitectTools(makeDeps());
  });

  it('throws ArchitectError for unknown tool name', async () => {
    await expect(executeArchitectTool('unknown_tool', {})).rejects.toThrow(ArchitectError);
  });

  // ─── architect_draft_workflow ─────────────────────────────────────

  describe('architect_draft_workflow', () => {
    it('calls generateWorkflow with prompt and returns result', async () => {
      const result = await executeArchitectTool('architect_draft_workflow', {
        prompt: 'Create a research pipeline',
      });

      expect(result).toHaveProperty('graph');
      expect(result).toHaveProperty('is_modification', false);
      expect(result).toHaveProperty('attempts', 1);
      expect(result).toHaveProperty('warnings');
    });

    it('passes current_graph for modification mode', async () => {
      const { generateWorkflow } = await import('../src/architect/index.js');

      await executeArchitectTool('architect_draft_workflow', {
        prompt: 'Add a review step',
        current_graph: {
          id: 'existing',
          name: 'Existing',
          description: 'Existing workflow',
          nodes: [{ id: 'a', type: 'agent', agent_id: 'agent-a' }],
          edges: [],
          start_node: 'a',
          end_nodes: ['a'],
        },
      });

      expect(generateWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Add a review step',
          currentGraph: expect.objectContaining({ id: 'existing' }),
        }),
      );
    });

    it('rejects a malformed current_graph with validation errors instead of drafting', async () => {
      const { generateWorkflow } = await import('../src/architect/index.js');
      (generateWorkflow as ReturnType<typeof vi.fn>).mockClear();

      const result = await executeArchitectTool('architect_draft_workflow', {
        prompt: 'Add a review step',
        current_graph: { id: 'existing', name: 'Existing' },
      });

      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('validation_errors');
      expect(generateWorkflow).not.toHaveBeenCalled();
    });

    it('throws on missing prompt', async () => {
      await expect(
        executeArchitectTool('architect_draft_workflow', {}),
      ).rejects.toThrow();
    });
  });

  // ─── architect_publish_workflow ───────────────────────────────────

  describe('architect_publish_workflow', () => {
    it('saves graph and returns published status', async () => {
      const deps = makeDeps();
      initArchitectTools(deps);

      const graph = makeGraph();
      const result = await executeArchitectTool('architect_publish_workflow', {
        graph,
      });

      expect(deps.saveGraph).toHaveBeenCalledTimes(1);
      expect((deps.saveGraph as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe('graph-1');
      expect(result).toHaveProperty('status', 'published');
      expect(result).toHaveProperty('graph_id', 'graph-1');
    });

    it('rejects a graph that fails schema validation (does not persist)', async () => {
      const deps = makeDeps();
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: { id: 'bad', name: 'Bad', nodes: [], edges: [], start_node: 'x' },
      });

      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('validation_errors');
      expect(deps.saveGraph).not.toHaveBeenCalled();
    });

    it('rejects a graph that fails referential validation (start_node missing)', async () => {
      const deps = makeDeps();
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: {
          id: 'bad-ref',
          name: 'Bad Ref',
          description: 'dangling start',
          nodes: [{ id: 'a', type: 'agent', agent_id: 'x', read_keys: ['goal'], write_keys: ['r'] }],
          edges: [],
          start_node: 'does-not-exist',
          end_nodes: ['a'],
        },
      });

      expect(result).toHaveProperty('error');
      expect(deps.saveGraph).not.toHaveBeenCalled();
    });

    it('honors the canPublish gate — denies and does not persist', async () => {
      const deps = makeDeps({ canPublish: () => 'human approval required' });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('human approval required');
      expect(deps.saveGraph).not.toHaveBeenCalled();
    });

    it('denies with a generic message when the gate returns false without a reason', async () => {
      const deps = makeDeps({ canPublish: () => false });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
      });

      expect((result as { error: string }).error).toBe('Publish denied by host policy.');
      expect(deps.saveGraph).not.toHaveBeenCalled();
    });

    it('honors the canPublish gate — allows and persists', async () => {
      const deps = makeDeps({ canPublish: () => true });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
      });

      expect(result).toHaveProperty('status', 'published');
      expect(deps.saveGraph).toHaveBeenCalledTimes(1);
    });

    it('fails closed when no gate and no opt-out are configured (does not persist)', async () => {
      const deps = makeDeps({ allowUnguardedPublish: false });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('no publish gate is configured');
      expect(deps.saveGraph).not.toHaveBeenCalled();
    });

    it('allowUnguardedPublish: true permits publishing without a gate', async () => {
      const deps = makeDeps({ allowUnguardedPublish: true });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
      });

      expect(result).toHaveProperty('status', 'published');
      expect(deps.saveGraph).toHaveBeenCalledTimes(1);
    });

    it('canPublish gate overrides allowUnguardedPublish (gate wins)', async () => {
      const deps = makeDeps({
        allowUnguardedPublish: true,
        canPublish: () => 'policy says no',
      });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('policy says no');
      expect(deps.saveGraph).not.toHaveBeenCalled();
    });

    it('returns error when graph exists and overwrite is false', async () => {
      const existingGraph = makeGraph();
      const deps = makeDeps({
        loadGraph: vi.fn().mockResolvedValue(existingGraph),
      });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
        overwrite: false,
      });

      expect(result).toHaveProperty('error');
      expect(deps.saveGraph).not.toHaveBeenCalled();
    });

    it('overwrites existing graph when overwrite is true', async () => {
      const existingGraph = makeGraph();
      const deps = makeDeps({
        loadGraph: vi.fn().mockResolvedValue(existingGraph),
      });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_publish_workflow', {
        graph: makeGraph(),
        overwrite: true,
      });

      expect(result).toHaveProperty('status', 'updated');
      expect(deps.saveGraph).toHaveBeenCalled();
    });

    it('throws when publishing before tools are initialized', async () => {
      vi.resetModules();
      const fresh = await import('../src/architect/tools.js');

      await expect(
        fresh.executeArchitectTool('architect_publish_workflow', { graph: makeGraph() }),
      ).rejects.toThrow('Architect tools not initialized');
    });

    it('rejects a publish payload missing the graph field', async () => {
      await expect(
        executeArchitectTool('architect_publish_workflow', {}),
      ).rejects.toThrow();
    });
  });

  // ─── architect_get_workflow ──────────────────────────────────────

  describe('architect_get_workflow', () => {
    it('returns graph when found', async () => {
      const graph = makeGraph();
      const deps = makeDeps({
        loadGraph: vi.fn().mockResolvedValue(graph),
      });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_get_workflow', {
        graph_id: 'graph-1',
      });

      expect(result).toHaveProperty('graph');
      expect((result as any).graph.id).toBe('graph-1');
    });

    it('returns error when graph not found', async () => {
      const deps = makeDeps({
        loadGraph: vi.fn().mockResolvedValue(null),
      });
      initArchitectTools(deps);

      const result = await executeArchitectTool('architect_get_workflow', {
        graph_id: 'nonexistent',
      });

      expect(result).toHaveProperty('error');
      expect((result as any).graph_id).toBe('nonexistent');
    });

    it('throws on missing graph_id', async () => {
      await expect(
        executeArchitectTool('architect_get_workflow', {}),
      ).rejects.toThrow();
    });

    it('throws when fetching before tools are initialized', async () => {
      vi.resetModules();
      const fresh = await import('../src/architect/tools.js');

      await expect(
        fresh.executeArchitectTool('architect_get_workflow', { graph_id: 'graph-1' }),
      ).rejects.toThrow('Architect tools not initialized');
    });
  });
});

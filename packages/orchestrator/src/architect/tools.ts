/**
 * Architect Tools
 *
 * Built-in tools that allow agents to autonomously design and manage
 * workflows. Resolved as built-in tools via `MCPConnectionManager`,
 * alongside `save_to_memory`.
 *
 * Tools:
 * - `architect_draft_workflow` — Generate or modify a workflow graph from a prompt
 * - `architect_publish_workflow` — Save a graph to the registry
 * - `architect_get_workflow` — Fetch a published graph definition
 *
 * @module architect/tools
 */

import { z } from 'zod';
import { generateWorkflow } from './index.js';
import { GraphSchema } from '../types/graph.js';
import { validateGraph } from '../validation/graph-validator.js';

/**
 * Tool definition used by the agent executor.
 */
export interface ToolDefinition {
  /** Human-readable description of what the tool does. */
  description: string;
  /** Zod schema for tool input parameters. */
  parameters: z.ZodType;
}
import { createLogger } from '../utils/logger.js';
import type { Graph } from '../types/graph.js';
import { ArchitectError } from './errors.js';

const logger = createLogger('architect.tools');

// ─── Zod schemas for tool argument validation ───────────────────────────

const DraftWorkflowArgsSchema = z.object({
  prompt: z.string(),
  current_graph: z.record(z.string(), z.unknown()).optional(),
});

const PublishWorkflowArgsSchema = z.object({
  graph: z.record(z.string(), z.unknown()),
  overwrite: z.boolean().default(false),
});

const GetWorkflowArgsSchema = z.object({
  graph_id: z.string(),
});

// ─── Tool Definitions ───────────────────────────────────────────────────

/** Tool definitions exposed to agents via the tool adapter. */
export const architectToolDefinitions: Record<string, ToolDefinition> = {
  architect_draft_workflow: {
    description:
      'Generate a new workflow graph from a natural language description, or modify an existing one. ' +
      'Returns a Graph JSON for review. Pass current_graph to modify an existing workflow.',
    parameters: z.object({
      prompt: z.string().describe('Natural language description of the workflow to create or change to make'),
      current_graph: z.record(z.string(), z.unknown()).optional().describe('Optional: existing graph JSON to modify'),
    }),
  },

  architect_publish_workflow: {
    description:
      'Save a workflow graph to the registry so it can be triggered via the Workflow API. ' +
      'Set overwrite to true to update an existing published workflow.',
    parameters: z.object({
      graph: z.record(z.string(), z.unknown()).describe('The complete graph JSON to publish'),
      overwrite: z.boolean().default(false).describe('Whether to overwrite an existing graph with the same ID'),
    }),
  },

  architect_get_workflow: {
    description: 'Fetch a published workflow graph definition by its ID.',
    parameters: z.object({
      graph_id: z.string().describe('The ID of the graph to fetch'),
    }),
  },
};

// ─── Persistence Interface ──────────────────────────────────────────────

/**
 * Dependencies that must be wired by the host application at startup.
 *
 * These map directly to {@link PersistenceProvider} methods but are
 * kept as a minimal interface to avoid coupling tools to the full
 * persistence layer.
 */
export interface ArchitectToolDeps {
  saveGraph: (graph: Graph) => Promise<void>;
  loadGraph: (graphId: string) => Promise<Graph | null>;
  /**
   * Optional publish gate. When provided, `architect_publish_workflow`
   * calls it AFTER the graph passes schema + referential validation but
   * BEFORE `saveGraph`. Return `false` (or a string reason) to deny the
   * publish — e.g. to require human approval, check a privileged
   * credential, or apply policy. Without it, any agent holding the
   * `architect_publish_workflow` tool can publish executable graphs, so
   * gating is strongly recommended for untrusted/agent-driven callers.
   */
  canPublish?: (graph: Graph) => Promise<boolean | string> | boolean | string;
}

let _deps: ArchitectToolDeps | null = null;

/**
 * Initialize architect tools with persistence dependencies.
 *
 * Must be called once at startup before agents can use architect tools.
 *
 * @param deps - Persistence callbacks for saving and loading graphs.
 */
export function initArchitectTools(deps: ArchitectToolDeps): void {
  _deps = deps;
  logger.info('architect_tools_initialized');
}

// ─── Tool Execution ─────────────────────────────────────────────────────

/**
 * Execute an architect tool call.
 *
 * @param toolName - The name of the architect tool to execute.
 * @param args - The raw arguments from the LLM tool call.
 * @returns The tool result object.
 * @throws {Error} If the tool name is unknown or dependencies are not initialised.
 */
export async function executeArchitectTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'architect_draft_workflow':
      return handleDraftWorkflow(args);

    case 'architect_publish_workflow':
      return handlePublishWorkflow(args);

    case 'architect_get_workflow':
      return handleGetWorkflow(args);

    default:
      throw new ArchitectError(`Unknown architect tool: ${toolName}`);
  }
}

// ─── Tool Handlers ──────────────────────────────────────────────────────

/**
 * Generate or modify a workflow graph from a natural language prompt.
 *
 * @param args - Raw tool arguments (validated via Zod before use).
 * @returns The drafted workflow graph with metadata.
 */
async function handleDraftWorkflow(args: Record<string, unknown>) {
  const { prompt, current_graph: currentGraph } = DraftWorkflowArgsSchema.parse(args);

  logger.info('tool_draft', { prompt: prompt.slice(0, 80) });

  const result = await generateWorkflow({
    prompt,
    current_graph: currentGraph as Graph | undefined,
  });

  return {
    graph: result.graph,
    is_modification: result.is_modification,
    attempts: result.attempts,
    warnings: result.warnings,
  };
}

/**
 * Publish a workflow graph to the registry.
 *
 * @param args - Raw tool arguments (validated via Zod before use).
 * @returns Status object indicating publish or update result.
 * @throws {Error} If architect tools have not been initialised.
 */
async function handlePublishWorkflow(args: Record<string, unknown>) {
  if (!_deps) {
    throw new ArchitectError('Architect tools not initialized. Call initArchitectTools() at startup.');
  }

  const { graph, overwrite } = PublishWorkflowArgsSchema.parse(args);

  // SECURITY: never persist an unvalidated graph. The tool accepts an
  // arbitrary object the agent constructs, so a prompt-injected or buggy
  // agent could otherwise publish an executable graph with wildcard
  // read_keys, unbounded fan-out, or arbitrary tool wiring. Structurally
  // validate (GraphSchema) AND check referential integrity (validateGraph)
  // before it can ever reach saveGraph / the Workflow API.
  const parsed = GraphSchema.safeParse(graph);
  if (!parsed.success) {
    logger.warn('tool_publish_rejected_schema', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 10),
    });
    return {
      error: 'Graph failed schema validation and was not published.',
      validation_errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const typedGraph = parsed.data;

  const referential = validateGraph(typedGraph);
  if (!referential.valid) {
    logger.warn('tool_publish_rejected_referential', { errors: referential.errors });
    return {
      error: 'Graph failed referential validation and was not published.',
      validation_errors: referential.errors,
      graph_id: typedGraph.id,
    };
  }

  const existing = await _deps.loadGraph(typedGraph.id);
  if (existing && !overwrite) {
    return {
      error: `Graph "${typedGraph.id}" already exists. Set overwrite to true to update it.`,
      graph_id: typedGraph.id,
    };
  }

  // Optional host-controlled gate (human approval, privileged credential, policy).
  if (_deps.canPublish) {
    const decision = await _deps.canPublish(typedGraph);
    if (decision !== true) {
      logger.warn('tool_publish_denied_by_gate', { graph_id: typedGraph.id });
      return {
        error: typeof decision === 'string'
          ? `Publish denied: ${decision}`
          : 'Publish denied by host policy.',
        graph_id: typedGraph.id,
      };
    }
  }

  await _deps.saveGraph(typedGraph);
  logger.info('tool_publish', { graph_id: typedGraph.id, overwrite });

  return {
    graph_id: typedGraph.id,
    name: typedGraph.name,
    status: existing ? 'updated' : 'published',
  };
}

/**
 * Fetch a published workflow graph by ID.
 *
 * @param args - Raw tool arguments (validated via Zod before use).
 * @returns The graph object or an error message if not found.
 * @throws {Error} If architect tools have not been initialised.
 */
async function handleGetWorkflow(args: Record<string, unknown>) {
  if (!_deps) {
    throw new ArchitectError('Architect tools not initialized. Call initArchitectTools() at startup.');
  }

  const { graph_id: graphId } = GetWorkflowArgsSchema.parse(args);
  const graph = await _deps.loadGraph(graphId);

  if (!graph) {
    return { error: `Graph "${graphId}" not found`, graph_id: graphId };
  }

  return { graph };
}

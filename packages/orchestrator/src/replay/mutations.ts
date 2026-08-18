/**
 * Changes
 *
 * What a fork does differently from the run it forked. Two layers, the same
 * relationship `createGraph` has to `GraphSchema`: {@link ChangeSchema} is the
 * snake_case wire form that persists and makes a fork reproducible, and
 * {@link change} is the camelCase authoring layer over it.
 *
 * Changes apply in three phases rather than in sequence. `memory` rewrites the
 * forked state before the tail runs, the agent and node overrides install
 * overlays, and the execution-time forms fire from middleware. Ordering matters
 * only between changes in the same phase, which is why two changes touching one
 * target are a conflict rather than a last-one-wins.
 *
 * @module replay/mutations
 */

import { z } from 'zod';

/** Swap the model behind a node's agent. */
export const ModelChangeSchema = z.object({
  kind: z.literal('model'),
  target: z.string(),
  model: z.string(),
  provider: z.string().optional(),
});

/** Replace a node agent's system prompt. */
export const PromptChangeSchema = z.object({
  kind: z.literal('prompt'),
  target: z.string(),
  system_prompt: z.string(),
});

/** Resample a node's agent at a different temperature. */
export const TemperatureChangeSchema = z.object({
  kind: z.literal('temperature'),
  target: z.string(),
  temperature: z.number().min(0).max(1),
});

/** Patch the forked state's memory before the tail runs. */
export const MemoryChangeSchema = z.object({
  kind: z.literal('memory'),
  set: z.record(z.string(), z.unknown()).optional(),
  delete: z.array(z.string()).optional(),
});

/** Patch a node's own config. */
export const NodeConfigChangeSchema = z.object({
  kind: z.literal('config'),
  node_id: z.string(),
  patch: z.record(z.string(), z.unknown()),
});

/** Force a routing decision the base run did not take. */
export const RouteChangeSchema = z.object({
  kind: z.literal('route'),
  from_node_id: z.string(),
  to_node_id: z.string(),
  /** Apply only the first time the run leaves `from_node_id`. */
  once: z.boolean().optional(),
});

/** Substitute a node's output instead of executing it. */
export const OutputChangeSchema = z.object({
  kind: z.literal('output'),
  node_id: z.string(),
  /** Memory the node is treated as having written. */
  memory: z.record(z.string(), z.unknown()),
});

/** Substitute a tool node's result instead of calling the tool. */
export const ToolChangeSchema = z.object({
  kind: z.literal('tool'),
  node_id: z.string(),
  result: z.unknown(),
});

/** Answer an approval gate instead of pausing at it. */
export const HumanResponseChangeSchema = z.object({
  kind: z.literal('human_response'),
  decision: z.enum(['approved', 'rejected', 'edited']),
  data: z.unknown().optional(),
  memory_updates: z.record(z.string(), z.unknown()).optional(),
});

/** Everything a fork can do differently. */
export const ChangeSchema = z.discriminatedUnion('kind', [
  ModelChangeSchema,
  PromptChangeSchema,
  TemperatureChangeSchema,
  MemoryChangeSchema,
  NodeConfigChangeSchema,
  RouteChangeSchema,
  OutputChangeSchema,
  ToolChangeSchema,
  HumanResponseChangeSchema,
]);

export type Change = z.infer<typeof ChangeSchema>;
export type ModelChange = z.infer<typeof ModelChangeSchema>;
export type PromptChange = z.infer<typeof PromptChangeSchema>;
export type TemperatureChange = z.infer<typeof TemperatureChangeSchema>;
export type MemoryChange = z.infer<typeof MemoryChangeSchema>;
export type NodeConfigChange = z.infer<typeof NodeConfigChangeSchema>;
export type RouteChange = z.infer<typeof RouteChangeSchema>;
export type OutputChange = z.infer<typeof OutputChangeSchema>;
export type ToolChange = z.infer<typeof ToolChangeSchema>;
export type HumanResponseChange = z.infer<typeof HumanResponseChangeSchema>;

/** Changes that name an agent through a node target. */
export type AgentChange = ModelChange | PromptChange | TemperatureChange;

/** True for the changes that resolve a `target` to an agent. */
export function isAgentChange(c: Change): c is AgentChange {
  return c.kind === 'model' || c.kind === 'prompt' || c.kind === 'temperature';
}

/**
 * Build changes for {@link fork}.
 *
 * Targets are node ids, optionally with a dotted role for nodes that
 * reference more than one agent. See `replay/target.ts`.
 */
export const change = {
  /** Swap the model behind `target`'s agent. */
  model: (target: string, model: string, opts?: { provider?: string }): ModelChange => ({
    kind: 'model',
    target,
    model,
    ...(opts?.provider ? { provider: opts.provider } : {}),
  }),

  /** Replace `target`'s system prompt. */
  prompt: (target: string, systemPrompt: string): PromptChange => ({
    kind: 'prompt',
    target,
    system_prompt: systemPrompt,
  }),

  /** Resample `target` at a different temperature. */
  temperature: (target: string, temperature: number): TemperatureChange => ({
    kind: 'temperature',
    target,
    temperature,
  }),

  /** Patch the forked state's memory before the tail runs. */
  memory: (patch: { set?: Record<string, unknown>; delete?: string[] }): MemoryChange => ({
    kind: 'memory',
    ...(patch.set ? { set: patch.set } : {}),
    ...(patch.delete ? { delete: patch.delete } : {}),
  }),

  /** Patch a node's config. Re-validated before the tail runs. */
  config: (nodeId: string, patch: Record<string, unknown>): NodeConfigChange => ({
    kind: 'config',
    node_id: nodeId,
    patch,
  }),

  /** Send the run somewhere else when it leaves `fromNodeId`. */
  route: (fromNodeId: string, toNodeId: string, opts?: { once?: boolean }): RouteChange => ({
    kind: 'route',
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    ...(opts?.once ? { once: true } : {}),
  }),

  /** Treat a node as having written `memory`, without executing it. */
  output: (nodeId: string, memory: Record<string, unknown>): OutputChange => ({
    kind: 'output',
    node_id: nodeId,
    memory,
  }),

  /** Substitute a tool node's result instead of calling the tool. */
  tool: (nodeId: string, result: unknown): ToolChange => ({
    kind: 'tool',
    node_id: nodeId,
    result,
  }),

  /**
   * Answer every approval gate the tail reaches, instead of pausing at it.
   *
   * Applies to all of them, not one named node: a fork exists to run without
   * a human present, and a tail that pauses at the second gate has answered
   * nothing.
   */
  humanResponse: (
    decision: 'approved' | 'rejected' | 'edited',
    opts?: { data?: unknown; memoryUpdates?: Record<string, unknown> },
  ): HumanResponseChange => ({
    kind: 'human_response',
    decision,
    ...(opts?.data !== undefined ? { data: opts.data } : {}),
    ...(opts?.memoryUpdates ? { memory_updates: opts.memoryUpdates } : {}),
  }),
};

/** A short label for a change, used in conflict messages and reports. */
export function describeChange(c: Change): string {
  switch (c.kind) {
    case 'model': return `model of '${c.target}' → ${c.model}`;
    case 'prompt': return `prompt of '${c.target}'`;
    case 'temperature': return `temperature of '${c.target}' → ${c.temperature}`;
    case 'config': return `config of '${c.node_id}'`;
    case 'route': return `route '${c.from_node_id}' → '${c.to_node_id}'`;
    case 'output': return `output of '${c.node_id}'`;
    case 'tool': return `tool result of '${c.node_id}'`;
    case 'human_response': return `human response '${c.decision}'`;
    case 'memory': {
      const set = Object.keys(c.set ?? {});
      const removed = c.delete ?? [];
      const parts = [
        ...(set.length > 0 ? [`set ${set.join(', ')}`] : []),
        ...(removed.length > 0 ? [`delete ${removed.join(', ')}`] : []),
      ];
      return `memory ${parts.join(' and ') || '(no-op)'}`;
    }
  }
}

/** What a change writes, for the purpose of catching two that collide. */
function claims(c: Change): string[] {
  switch (c.kind) {
    case 'model':
    case 'prompt':
    case 'temperature':
      return [`${c.kind}:${c.target}`];
    case 'config':
      return Object.keys(c.patch).map(field => `config:${c.node_id}.${field}`);
    case 'route':
      return [`route:${c.from_node_id}`];
    case 'human_response':
      return ['human_response'];
    // An output override and a tool override on one node both decide what that
    // node produces, so they collide with each other as well as themselves.
    case 'output':
    case 'tool':
      return [`output:${c.node_id}`];
    case 'memory':
      return [
        ...Object.keys(c.set ?? {}).map(key => `memory:${key}`),
        ...(c.delete ?? []).map(key => `memory:${key}`),
      ];
  }
}

/**
 * Find changes that write the same thing.
 *
 * Two changes on one target are a copy-paste error in a sweep matrix far more
 * often than an intention, and silently letting the last one win would make a
 * fork report a cause that never applied.
 *
 * @returns One message per collision, empty when the set is coherent.
 */
export function detectConflicts(changes: readonly Change[]): string[] {
  const owners = new Map<string, Change>();
  const conflicts: string[] = [];

  for (const c of changes) {
    for (const claim of claims(c)) {
      const existing = owners.get(claim);
      if (existing) {
        conflicts.push(
          `${describeChange(existing)} and ${describeChange(c)} both write ${claim}. ` +
          `Drop one — a fork applies changes by phase, not in order, so which wins is not defined.`,
        );
        continue;
      }
      owners.set(claim, c);
    }
  }

  return conflicts;
}

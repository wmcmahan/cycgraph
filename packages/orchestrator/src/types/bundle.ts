/**
 * Graph Bundle — the portable distribution artifact
 *
 * A bundle carries everything about a composition that is data and can
 * travel: the entry graph, the transitive child-graph closure, and the
 * agent definitions they reference. Its manifest declares the two
 * contracts a consumer needs (docs/plans/graph-bundles.md): the interface
 * (input/output memory keys with schemas) and the host requirements
 * (custom tools, MCP servers, models — code and credentials the bundle
 * must NOT carry).
 *
 * The bundle is a serialization boundary, so everything here is
 * snake_case wire format, schema-validated because bundles arrive from
 * untrusted sources (npm packages, files, registries).
 *
 * @module types/bundle
 */

import { z } from 'zod';
import { GraphSchema, GraphInputDeclSchema, GraphOutputDeclSchema } from './graph.js';
import { ToolSourceSchema } from './tools.js';

/** Caps mirror GraphSchema's structural caps: bound untrusted artifacts. */
const MAX_BUNDLE_AGENTS = 10_000;
const MAX_BUNDLE_GRAPHS = 1_000;
const MAX_REQUIRE_ENTRIES = 10_000;

/** A custom tool the host must register to run the bundle. */
export const RequiredToolSchema = z.object({
  /** Tool name the graph's nodes/agents reference. */
  name: z.string().min(1),
  /** JSON Schema of the tool's arguments, when known at publish time. */
  input_schema: z.record(z.string(), z.unknown()).optional(),
  /** Whether the tool's output is untrusted external data. */
  taints: z.boolean().optional(),
});

/** The host dependency contract: what the bundle needs but must not carry. */
export const GraphRequiresSchema = z.object({
  /** Custom tool implementations, supplied by the host by name. */
  tools: z.array(RequiredToolSchema).max(MAX_REQUIRE_ENTRIES).default([]),
  /** MCP servers, registered by the host (endpoints and credentials are host concerns). */
  mcp_servers: z.array(z.object({
    id: z.string().min(1),
    description: z.string().optional(),
  })).max(MAX_REQUIRE_ENTRIES).default([]),
  /** Model ids the bundled agents use; provider keys derive from these. */
  models: z.array(z.string()).max(MAX_REQUIRE_ENTRIES).default([]),
});

/**
 * A bundled agent definition — the snake_case registry wire form. These
 * travel because they are pure data (model, prompt, structured tool
 * references); implementations never do.
 */
export const BundledAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable().optional(),
  model: z.string().min(1),
  provider: z.string().min(1),
  system_prompt: z.string(),
  temperature: z.number().min(0).max(1).optional(),
  max_steps: z.number().int().min(1).optional(),
  tools: z.array(ToolSourceSchema).max(1000).default([]),
  provider_options: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().optional(),
  model_preference: z.string().optional(),
  permissions: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** The manifest: identity plus the interface and dependency contracts. */
export const GraphManifestSchema = z.object({
  /** Bundle name (defaults to the graph's name at assembly). */
  name: z.string().min(1),
  /** Version, supplied at publish time — a packaging concern, never a graph field. */
  version: z.string().min(1),
  /** Human-readable description. */
  description: z.string().optional(),
  /**
   * Provenance: where this bundle is distributed from, e.g. an npm package
   * name. Self-declared attribution for audit trails. Cryptographic
   * verification is deferred; for npm distribution, integrity already rides
   * the consumer's lockfile, and this field records the linkage in the
   * artifact itself.
   */
  source: z.string().optional(),
  /** Interface contract: memory keys the graph expects seeded. */
  inputs: z.record(z.string(), GraphInputDeclSchema).default({}),
  /** Interface contract: memory keys the graph produces. */
  outputs: z.record(z.string(), GraphOutputDeclSchema).default({}),
  /** Dependency contract: what the host must provide. */
  requires: GraphRequiresSchema,
});

/** The portable artifact: manifest + entry graph + everything that travels. */
export const GraphBundleSchema = z.object({
  manifest: GraphManifestSchema,
  /** The entry graph, pure JSON wire form. */
  graph: GraphSchema,
  /** Agent definitions the composition references (entry graph and children). */
  agents: z.array(BundledAgentSchema).max(MAX_BUNDLE_AGENTS).default([]),
  /** The transitive child-graph closure. */
  graphs: z.array(GraphSchema).max(MAX_BUNDLE_GRAPHS).default([]),
});

export type RequiredToolWire = z.infer<typeof RequiredToolSchema>;
export type GraphRequires = z.infer<typeof GraphRequiresSchema>;
export type BundledAgent = z.infer<typeof BundledAgentSchema>;
export type GraphManifest = z.infer<typeof GraphManifestSchema>;
export type GraphBundle = z.infer<typeof GraphBundleSchema>;

/** Whether a value is shaped like a {@link GraphBundle}. Shape-based, so it
 * also recognizes bundles that crossed a structural boundary (JSON round-trip,
 * a different package instance). */
export function isGraphBundle(value: unknown): value is GraphBundle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'manifest' in value &&
    'graph' in value &&
    'agents' in value
  );
}

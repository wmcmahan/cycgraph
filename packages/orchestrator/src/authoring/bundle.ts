/**
 * bundle() — assemble a portable graph artifact
 *
 * Lifts a composed graph into a {@link GraphBundle}. The manifest carries
 * the declared interface and computed host requirements; the bundle embeds
 * the agent definitions and the transitive child-graph closure.
 * `JSON.stringify(bundle)` is the complete artifact, and `parseBundle()`
 * validates one arriving from an untrusted source.
 *
 * Implementations never travel: inline `tool()` code appears in
 * `requires.tools` for the host to supply by name.
 *
 * @module authoring/bundle
 */

import type { Graph } from '../graph/graph.js';
import {
  GraphBundleSchema,
  type BundledAgent,
  type GraphBundle,
} from './bundle-schema.js';
import { normalizeToolSources } from '../tools/schema.js';
import { camelToSnakeDeep } from '../utils/case-mapping.js';
import type { AgentRegistryConfig } from '../persistence/interfaces.js';
import { collectClosure } from './closure.js';
import { computeRequirements } from './requirements.js';

/** Identity and versioning supplied at assembly time. */
export interface BundleMeta {
  /** Bundle version. A packaging concern — never a graph field. */
  version: string;
  /** Bundle name. Defaults to the graph's name. */
  name?: string;
  /** Description. Defaults to the graph's description when non-empty. */
  description?: string;
  /** Provenance: where the bundle is distributed from, e.g. an npm package name. */
  source?: string;
}

/** Convert a stashed authoring config to the snake_case bundled wire form. */
function toBundledAgent(config: AgentRegistryConfig): BundledAgent {
  const wire = camelToSnakeDeep(config) as Record<string, unknown>;
  return {
    ...wire,
    tools: normalizeToolSources(wire.tools ?? []),
  } as BundledAgent;
}

/**
 * Assemble a {@link GraphBundle} from a facade-authored composition.
 *
 * The manifest's interface comes from the graph's declared `inputs` /
 * `outputs`; `requires` comes from {@link computeRequirements} over the
 * closure. The returned bundle keeps the ORIGINAL graph objects, so using
 * it locally (`subgraph(bundle, …)` then `run()`) still resolves in-scope
 * `tool()` implementations through the stashes. A serialized-and-reloaded
 * bundle carries only data — its `requires.tools` must then be supplied on
 * the runner by name.
 */
export function bundle(g: Graph, meta: BundleMeta): GraphBundle {
  const closure = collectClosure(g);
  const requirements = computeRequirements(g);

  const description = meta.description ?? (g.description !== '' ? g.description : undefined);
  const assembled = {
    manifest: {
      name: meta.name ?? g.name,
      version: meta.version,
      ...(description !== undefined ? { description } : {}),
      ...(meta.source !== undefined ? { source: meta.source } : {}),
      inputs: g.inputs ?? {},
      outputs: g.outputs ?? {},
      requires: {
        tools: requirements.tools.map(({ name, inputSchema, taints }) => ({
          name,
          ...(inputSchema !== undefined ? { input_schema: inputSchema } : {}),
          ...(taints ? { taints } : {}),
        })),
        mcp_servers: requirements.mcpServers,
        models: requirements.models,
      },
    },
    graph: g,
    agents: closure.agents.map(toBundledAgent),
    graphs: [...closure.children.values()],
  };

  // Validate the assembled artifact, then return it with the ORIGINAL graph
  // objects: schema parsing clones, and cloned graphs lose the identity-keyed
  // stashes that local runs use for inline tool resolution.
  const parsed = GraphBundleSchema.parse(assembled);
  return { ...parsed, graph: g, graphs: assembled.graphs };
}

/**
 * Thrown by {@link parseBundle} when a bundle's visible usage exceeds its
 * manifest: a node or bundled agent references a tool, MCP server, or model
 * the manifest's `requires` never declared. A manifest that under-declares
 * is either tampered or mis-assembled; rejecting it at load time keeps the
 * reviewed declaration honest before anything runs.
 */
export class BundleIntegrityError extends Error {
  constructor(public readonly violations: string[]) {
    super(
      `Bundle usage exceeds its manifest requires:\n  - ${violations.join('\n  - ')}`,
    );
    this.name = 'BundleIntegrityError';
  }
}

/**
 * Cross-check a parsed bundle's visible usage against its manifest. Visible
 * means what the artifact itself carries: tool sources on every graph's
 * nodes, and the tools and models of every bundled agent. The runtime
 * capability ceiling remains defense in depth for the one invisible path,
 * host-supplied agents referenced by id.
 */
function verifyBundleIntegrity(b: GraphBundle): void {
  const declaredTools = new Set(b.manifest.requires.tools.map((t) => t.name));
  const declaredServers = new Set(b.manifest.requires.mcp_servers.map((s) => s.id));
  const declaredModels = new Set(b.manifest.requires.models);
  const violations: string[] = [];

  const checkSources = (sources: readonly { type: string; name?: string; server_id?: string }[], where: string): void => {
    for (const source of sources) {
      if (source.type === 'custom' && source.name !== undefined && !declaredTools.has(source.name)) {
        violations.push(`${where} uses custom tool "${source.name}" not declared in requires.tools`);
      }
      if (source.type === 'mcp' && source.server_id !== undefined && !declaredServers.has(source.server_id)) {
        violations.push(`${where} uses MCP server "${source.server_id}" not declared in requires.mcp_servers`);
      }
    }
  };

  for (const g of [b.graph, ...b.graphs]) {
    for (const graphNode of g.nodes) {
      if (graphNode.tools) checkSources(graphNode.tools, `graph "${g.name}" node "${graphNode.id}"`);
    }
  }
  for (const bundledAgent of b.agents) {
    checkSources(bundledAgent.tools, `agent "${bundledAgent.name}"`);
    if (!declaredModels.has(bundledAgent.model)) {
      violations.push(`agent "${bundledAgent.name}" uses model "${bundledAgent.model}" not declared in requires.models`);
    }
  }

  if (violations.length > 0) {
    throw new BundleIntegrityError(violations);
  }
}

/**
 * Validate a bundle arriving from an untrusted source (a file, an npm
 * package, a registry). Throws on malformed input, and throws
 * {@link BundleIntegrityError} when the bundle's visible usage exceeds its
 * manifest. The npm convention: a graph package default-exports the object
 * this returns.
 */
export function parseBundle(data: unknown): GraphBundle {
  const parsed = GraphBundleSchema.parse(data);
  verifyBundleIntegrity(parsed);
  return parsed;
}

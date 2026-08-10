/**
 * computeRequirements() — a composition's dependency contract
 *
 * Walks a facade-authored composition (the graph plus its `subgraph()`
 * closure, the same walk `run()` uses to register) and collects what the
 * HOST must provide to run it: custom tool implementations, MCP servers,
 * and models (from which provider keys derive). This is the generated half
 * of the manifest's `requires` block — names and schemas, never implementations.
 *
 * Built-in tools are excluded: the engine ships them, so they are not a
 * host requirement. Agents referenced by bare id (not authored inline)
 * contribute nothing here — their models are unknowable without a registry,
 * which is a documented limit of the pre-bundle path.
 *
 * @module authoring/requirements
 */

import type { Graph } from '../types/graph.js';
import { normalizeToolSources } from '../types/tools.js';
import { isGraphBundle, type GraphBundle } from '../types/bundle.js';
import type { MCPServerRegistry } from '../persistence/interfaces.js';
import type { ProviderRegistry } from '../agent/provider-registry.js';
import { isDefinedTool } from '../tools/define-tool.js';
import type { ToolsOption } from '../tools/registry.js';
import { agentsForGraph, graphsForGraph, toolsForGraph } from './graph.js';

/** A custom tool the host must register (schema present when known). */
export interface RequiredTool {
  name: string;
  /** JSON Schema of the tool's arguments, when an implementation was in scope at compile time. */
  inputSchema?: Record<string, unknown>;
  /** Whether the tool declares its output as untrusted external data. */
  taints?: boolean;
}

/** What a composition needs from its host environment. */
export interface GraphRequirements {
  tools: RequiredTool[];
  mcpServers: Array<{ id: string }>;
  models: string[];
}

/**
 * Compute the host requirements of `root` and its `subgraph()` closure.
 * Deterministic: results are sorted by name, id, and model.
 */
export function computeRequirements(root: Graph): GraphRequirements {
  const toolNames = new Map<string, RequiredTool>();
  const serverIds = new Set<string>();
  const models = new Set<string>();

  const visited = new Set<Graph>([root]);
  const queue: Graph[] = [root];

  const collectSources = (sources: unknown): void => {
    for (const source of normalizeToolSources(sources)) {
      if (source.type === 'custom') {
        if (!toolNames.has(source.name)) toolNames.set(source.name, { name: source.name });
      } else if (source.type === 'mcp') {
        serverIds.add(source.server_id);
      }
      // 'builtin' sources ship with the engine — not a host requirement.
    }
  };

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const node of current.nodes) {
      if (node.tools) collectSources(node.tools);
    }

    for (const config of agentsForGraph(current)) {
      models.add(config.model);
      if (config.tools) collectSources(config.tools);
    }

    // Implementations that were in scope at compile time enrich the entry
    // with the argument schema and taint declaration — the contract the
    // host's replacement implementation must honor.
    for (const impl of toolsForGraph(current)) {
      toolNames.set(impl.name, {
        name: impl.name,
        inputSchema: impl.parameters,
        ...(impl.taints ? { taints: true } : {}),
      });
    }

    for (const child of graphsForGraph(current)) {
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  }

  return {
    tools: [...toolNames.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mcpServers: [...serverIds].sort().map((id) => ({ id })),
    models: [...models].sort(),
  };
}

/** What the host offers, for {@link checkRequirements}. */
export interface RequirementsHost {
  /**
   * Tool implementations and resolvers the runner would receive. Only
   * `tool()` / `defineTool()` values satisfy required custom tools by name;
   * resolvers cannot be enumerated without connecting.
   */
  tools?: ToolsOption[];
  /**
   * MCP server registry. When omitted and the composition requires servers,
   * they are all reported missing — server availability cannot be assumed.
   */
  mcpServers?: MCPServerRegistry;
  /**
   * Provider registry for the advisory model check. When omitted, models
   * are not checked (the run would use the global registry's built-ins).
   */
  providers?: ProviderRegistry;
}

/** Result of {@link checkRequirements}: what the host is missing. */
export interface RequirementsCheck {
  /** True when no required tools or MCP servers are missing. */
  ok: boolean;
  /** Required custom tools with no implementation among `host.tools`. */
  missingTools: string[];
  /** Required MCP server ids absent from `host.mcpServers`. */
  missingMcpServers: string[];
  /**
   * Models no registered provider lists. Advisory only — model lists are
   * not an allowlist (unknown models are forwarded with a warning) — so
   * these never affect `ok`.
   */
  unknownModels: string[];
}

/**
 * Preflight a composition's requirements against a host, failing fast with
 * the missing list instead of deep in execution. Pass a `Graph` to compute
 * requirements from the composition closure, or a `GraphBundle` to check
 * its manifest's declared `requires` — the manifest is what makes a
 * deserialized bundle checkable without its authoring stashes.
 */
export async function checkRequirements(
  target: Graph | GraphBundle,
  host: RequirementsHost = {},
): Promise<RequirementsCheck> {
  const required = isGraphBundle(target)
    ? {
        tools: target.manifest.requires.tools.map((t) => t.name),
        servers: target.manifest.requires.mcp_servers.map((s) => s.id),
        models: target.manifest.requires.models,
      }
    : (() => {
        const requirements = computeRequirements(target);
        return {
          tools: requirements.tools.map((t) => t.name),
          servers: requirements.mcpServers.map((s) => s.id),
          models: requirements.models,
        };
      })();

  const suppliedTools = new Set(
    (host.tools ?? []).filter(isDefinedTool).map((t) => t.name),
  );
  const missingTools = required.tools.filter((name) => !suppliedTools.has(name)).sort();

  const missingMcpServers: string[] = [];
  for (const id of required.servers) {
    if (!host.mcpServers || (await host.mcpServers.loadServer(id)) === null) {
      missingMcpServers.push(id);
    }
  }
  missingMcpServers.sort();

  const unknownModels = host.providers
    ? required.models
        .filter((model) => {
          const providers = host.providers!.listProviders();
          return !providers.some((name) => host.providers!.supportsModel(name, model));
        })
        .sort()
    : [];

  return {
    ok: missingTools.length === 0 && missingMcpServers.length === 0,
    missingTools,
    missingMcpServers,
    unknownModels,
  };
}

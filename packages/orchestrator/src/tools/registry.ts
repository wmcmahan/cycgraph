/**
 * Composed Tool Resolution
 *
 * Builds the runner's tool-resolution pipeline from the single
 * `GraphRunnerOptions.tools` array: built-in catalog → `defineTool()`
 * registrations → `ToolResolver` entries (typically an MCPConnectionManager).
 * The composed object implements {@link ToolResolver}, so the rest of the
 * engine sees one resolver.
 *
 * Taint attribution: the composed resolver keeps a per-resolution collector
 * for custom tools and delegates MCP taint to each leg with that leg's own
 * toolset handle, preserving race-free per-execution attribution under
 * concurrent fan-out.
 *
 * Multi-resolver semantics: MCP sources are forwarded as one batch to each
 * resolver in array order until one resolves them all, and a resolver that
 * does not know one declared server fails the whole batch. A node's declared
 * servers must therefore all be owned by a single resolver.
 *
 * @module tools/registry
 */

import type { TaintMetadata } from '../state/state.js';
import type { ToolSource, MCPToolSource } from './schema.js';
import type { ToolResolver } from './resolver.js';
import type { DefinedTool } from './define-tool.js';
import { resolveBuiltinTools } from './builtin/index.js';
import { ToolDefinitionError, isDefinedTool } from './define-tool.js';
import { createLogger } from '../observability/logger.js';

const logger = createLogger('tools.registry');

/** Anything `GraphRunnerOptions.tools` accepts: a defined tool or a resolver. */
export type ToolsOption = DefinedTool | ToolResolver;

/** Thrown when a `{ type: 'custom' }` source names an unregistered tool. */
export class ToolNotRegisteredError extends Error {
  constructor(public readonly toolName: string) {
    super(
      `Custom tool "${toolName}" is not registered — add its defineTool() result to GraphRunnerOptions.tools`,
    );
    this.name = 'ToolNotRegisteredError';
  }
}

/**
 * The capability surface a capped run may reach: custom tool names and MCP
 * server ids. Derived from a bundle manifest's `requires` and enforced at
 * tool resolution — a graph cannot use more than it declared. Built-in
 * tools are uncapped (the engine ships them; `requires` never lists them).
 * See docs/plans/capability-isolation.md.
 */
export interface CapabilityCeiling {
  tools: string[];
  mcpServers: string[];
}

/** Thrown when a capped run resolves a tool source outside its ceiling. */
export class CapabilityViolationError extends Error {
  constructor(
    public readonly kind: 'tool' | 'mcp_server',
    public readonly name: string,
  ) {
    super(
      kind === 'tool'
        ? `Custom tool "${name}" is outside this graph's declared capability ceiling — it was not in the manifest's requires.tools`
        : `MCP server "${name}" is outside this graph's declared capability ceiling — it was not in the manifest's requires.mcp_servers`,
    );
    this.name = 'CapabilityViolationError';
  }
}

/** Intersect two ceilings: the surface allowed by both. */
export function intersectCeilings(a: CapabilityCeiling, b: CapabilityCeiling): CapabilityCeiling {
  const bTools = new Set(b.tools);
  const bServers = new Set(b.mcpServers);
  return {
    tools: a.tools.filter((name) => bTools.has(name)),
    mcpServers: a.mcpServers.filter((id) => bServers.has(id)),
  };
}

/** Runtime shape discrimination for the `tools` option array. */
function isToolResolver(entry: ToolsOption): entry is ToolResolver {
  return typeof (entry as ToolResolver).resolveTools === 'function';
}

/** Per-merged-toolset drain bookkeeping (see drainTaintEntries). */
interface ResolutionRecord {
  collector: Map<string, TaintMetadata>;
  parts: Array<{ resolver: ToolResolver; toolset: Record<string, unknown> }>;
}

/**
 * The composed resolution pipeline. Implements {@link ToolResolver} so it
 * drops into the existing executor-context wiring; exposes the registered
 * custom-tool names and resolver presence for the runner's preflight
 * wiring check.
 */
export class ComposedToolResolution implements ToolResolver {
  private readonly definedTools = new Map<string, DefinedTool>();
  private readonly resolvers: ToolResolver[] = [];
  /** Drain bookkeeping keyed by the merged toolset object (GC'd with it). */
  private readonly resolutions = new WeakMap<object, ResolutionRecord>();
  /** Process-wide fallback accumulator for no-arg drains (legacy parity). */
  private readonly fallbackTaint = new Map<string, TaintMetadata>();
  /** Capability ceiling, when this run is capped (fail-closed at resolution). */
  private readonly allowedTools?: ReadonlySet<string>;
  private readonly allowedServers?: ReadonlySet<string>;

  constructor(entries: ToolsOption[], options?: { capabilityCeiling?: CapabilityCeiling }) {
    if (options?.capabilityCeiling) {
      this.allowedTools = new Set(options.capabilityCeiling.tools);
      this.allowedServers = new Set(options.capabilityCeiling.mcpServers);
    }
    for (const entry of entries) {
      if (isToolResolver(entry)) {
        this.resolvers.push(entry);
        continue;
      }
      if (isDefinedTool(entry)) {
        if (this.definedTools.has(entry.name)) {
          throw new ToolDefinitionError(
            `Duplicate custom tool name "${entry.name}" in GraphRunnerOptions.tools`,
          );
        }
        this.definedTools.set(entry.name, entry);
        continue;
      }
      throw new ToolDefinitionError(
        'GraphRunnerOptions.tools entries must be defineTool() results or ToolResolver implementations',
      );
    }
  }

  /** Names of registered `defineTool()` tools — consumed by runner preflight. */
  get definedToolNames(): ReadonlySet<string> {
    return new Set(this.definedTools.keys());
  }

  /** Whether any `ToolResolver` leg (MCP) is registered — consumed by preflight. */
  get hasResolver(): boolean {
    return this.resolvers.length > 0;
  }

  async resolveTools(sources: ToolSource[], agentId?: string): Promise<Record<string, unknown>> {
    const collector = new Map<string, TaintMetadata>();
    const tools: Record<string, unknown> = {};

    const builtinSources = sources.filter((s) => s.type === 'builtin');
    const customSources = sources.filter((s) => s.type === 'custom');
    const mcpSources = sources.filter((s): s is MCPToolSource => s.type === 'mcp');

    // Capability ceiling first, and BEFORE the registration lookup: a
    // registered-but-undeclared tool must surface as a capability violation,
    // not resolve. This is the choke point every path funnels through —
    // node tools, agent-config tools, synthetic sub-nodes — so agent configs
    // resolved from the registry at runtime are capped too.
    if (this.allowedTools) {
      for (const source of customSources) {
        if (!this.allowedTools.has(source.name)) {
          throw new CapabilityViolationError('tool', source.name);
        }
      }
    }
    if (this.allowedServers) {
      for (const source of mcpSources) {
        if (!this.allowedServers.has(source.server_id)) {
          throw new CapabilityViolationError('mcp_server', source.server_id);
        }
      }
    }

    Object.assign(tools, resolveBuiltinTools(builtinSources));

    for (const source of customSources) {
      const defined = this.definedTools.get(source.name);
      if (!defined) {
        throw new ToolNotRegisteredError(source.name);
      }
      tools[defined.name] = this.toRawToolDefinition(defined, collector);
    }

    const parts: ResolutionRecord['parts'] = [];
    if (mcpSources.length > 0) {
      const { resolver, toolset } = await this.resolveMcpBatch(mcpSources, agentId);
      parts.push({ resolver, toolset });

      for (const [name, tool] of Object.entries(toolset)) {
        // Local tools win name collisions: they are first-party and
        // deliberately registered. The MCP tool stays reachable under a
        // deterministic prefixed name, mirroring the manager's own
        // cross-server namespacing.
        const finalName = name in tools ? `mcp__${name}` : name;
        if (finalName !== name) {
          logger.warn('mcp_tool_shadowed_by_local', { tool_name: name, namespaced_as: finalName });
        }
        tools[finalName] = tool;
      }
    }

    this.resolutions.set(tools, { collector, parts });
    return tools;
  }

  /**
   * Forward the MCP batch to each resolver in order until one resolves it.
   * Unknown-server errors try the next resolver; anything else propagates.
   */
  private async resolveMcpBatch(
    sources: MCPToolSource[],
    agentId?: string,
  ): Promise<{ resolver: ToolResolver; toolset: Record<string, unknown> }> {
    if (this.resolvers.length === 0) {
      const serverIds = [...new Set(sources.map((s) => s.server_id))].join(', ');
      throw new Error(
        `MCP tool sources declared (servers: ${serverIds}) but no ToolResolver is registered on GraphRunnerOptions.tools`,
      );
    }

    let lastNotFound: Error | undefined;
    for (const resolver of this.resolvers) {
      try {
        const toolset = await resolver.resolveTools(sources, agentId);
        return { resolver, toolset };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'MCPServerNotFoundError' && resolver !== this.resolvers[this.resolvers.length - 1]) {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }
    throw lastNotFound ?? new Error('MCP tool resolution failed');
  }

  /**
   * Project a {@link DefinedTool} to the raw definition shape the agent
   * executor's `buildToolSet()` wraps, adding taint recording for
   * `taints: true` tools. Taint is recorded on the error path too — a
   * throwing external-data tool still delivers attacker-influencable text
   * (its message) into the LLM context.
   */
  private toRawToolDefinition(
    defined: DefinedTool,
    collector: Map<string, TaintMetadata>,
  ): Record<string, unknown> {
    if (!defined.taints) {
      return {
        description: defined.description,
        parameters: defined.parameters,
        execute: defined.execute,
      };
    }

    const recordTaint = () => {
      const entry: TaintMetadata = {
        source: 'custom_tool',
        tool_name: defined.name,
        created_at: new Date().toISOString(),
      };
      collector.set(`custom:${defined.name}`, entry);
      this.fallbackTaint.set(`custom:${defined.name}`, entry);
    };

    return {
      description: defined.description,
      parameters: defined.parameters,
      execute: async (args: unknown): Promise<unknown> => {
        try {
          const result = await defined.execute(args);
          recordTaint();
          return result;
        } catch (err) {
          recordTaint();
          throw err;
        }
      },
    };
  }

  drainTaintEntries(tools?: Record<string, unknown>): Map<string, TaintMetadata> {
    if (tools) {
      const record = this.resolutions.get(tools);
      if (record) {
        const entries = new Map(record.collector);
        record.collector.clear();
        for (const part of record.parts) {
          const drained = part.resolver.drainTaintEntries?.(part.toolset);
          if (drained) {
            for (const [key, value] of drained) entries.set(key, value);
          }
        }
        return entries;
      }
    }

    const entries = new Map(this.fallbackTaint);
    this.fallbackTaint.clear();
    for (const resolver of this.resolvers) {
      const drained = resolver.drainTaintEntries?.();
      if (drained) {
        for (const [key, value] of drained) entries.set(key, value);
      }
    }
    return entries;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.resolvers.map((resolver) => resolver.closeAll()));
  }
}

/**
 * Build the composed resolution from the `GraphRunnerOptions.tools` array.
 * Throws {@link ToolDefinitionError} at construction on duplicate custom
 * names or invalid entries — a config error, surfaced before any run.
 */
export function composeToolResolution(
  entries: ToolsOption[],
  options?: { capabilityCeiling?: CapabilityCeiling },
): ComposedToolResolution {
  return new ComposedToolResolution(entries, options);
}

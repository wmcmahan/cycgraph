/**
 * MCP Connection Manager
 *
 * Manages lifecycle of `@ai-sdk/mcp` client connections per workflow run.
 * Resolves agent ToolSource declarations into AI SDK tool sets by looking up server
 * configs from the trusted MCPServerRegistry.
 *
 * Key design decisions:
 * - Lazy connection: clients are created on first use, not at startup
 * - Connection dedup: concurrent resolveTools() calls for the same server
 *   share a single pending connection promise (stampede prevention)
 * - Immutable taint wrapping: tool execute functions are wrapped without
 *   mutating the shared tool objects from `@ai-sdk/mcp`
 * - Collision-only namespacing: tools are namespaced with `serverId__` prefix
 *   only when actual name collisions are detected across servers
 *
 * @module mcp/connection-manager
 */

import { createLogger } from '../utils/logger.js';
import { MCPServerNotFoundError, MCPAccessDeniedError } from './errors.js';
import {
  ToolCircuitBreakerManager,
  type ToolCircuitBreakerMetrics,
  type ToolCircuitBreakerOptions,
} from './tool-circuit-breaker.js';
import { Semaphore } from './semaphore.js';
import type { MCPServerRegistry } from '../persistence/interfaces.js';
import type { ToolSource, MCPServerEntry } from '../types/tools.js';
import { isStdioMcpDisabled } from '../types/tools.js';
import { assertHostResolvesPublic, scrubStdioEnv } from './transport-security.js';
import type { TaintMetadata } from '../types/state.js';

const logger = createLogger('mcp.connections');

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Taint-wrapped tool result returned by MCP tool execution.
 */
export interface TaintedToolResult {
  readonly result: unknown;
  readonly taint: TaintMetadata;
}

/**
 * Abstract interface for tool resolution (DI seam for testing).
 */
export interface ToolResolver {
  /**
   * Resolve an array of ToolSource declarations into an AI SDK tool set.
   * Returns a merged record of tool name → tool object with execute functions.
   *
   * @param sources - Tool source declarations from the agent config.
   * @param agentId - The requesting agent's ID (for access control).
   */
  resolveTools(sources: ToolSource[], agentId?: string): Promise<Record<string, unknown>>;

  /**
   * Close all open MCP client connections and release resources.
   */
  closeAll(): Promise<void>;

  /**
   * Drain accumulated taint entries from MCP tool executions.
   *
   * Pass the exact toolset returned by a prior `resolveTools()` call to drain
   * ONLY that execution's taint — required for correctness under concurrent
   * executions (voting / evolution / map), where a single shared accumulator
   * would let one agent's drain swallow another's still-accumulating entries.
   * Called with no argument, falls back to a process-wide accumulator
   * (legacy / single-execution behavior).
   *
   * Optional — only implemented by MCPConnectionManager.
   */
  drainTaintEntries?(tools?: Record<string, unknown>): Map<string, TaintMetadata>;
}

// ─── Lazy Imports ───────────────────────────────────────────────────

// @ai-sdk/mcp is an optional peer dependency. We import lazily to avoid
// hard failures when it's not installed (e.g., in unit tests that only
// use built-in tools).

type MCPClientType = {
  tools(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

type CreateMCPClientFn = (config: {
  transport: unknown;
  name?: string;
  onUncaughtError?: (error: unknown) => void;
}) => Promise<MCPClientType>;

let _createMCPClient: CreateMCPClientFn | null = null;
let _StdioTransport: (new (config: { command: string; args?: string[]; env?: Record<string, string> }) => unknown) | null = null;

async function getCreateMCPClient(): Promise<CreateMCPClientFn> {
  if (!_createMCPClient) {
    const mod = await import('@ai-sdk/mcp');
    _createMCPClient = mod.createMCPClient as CreateMCPClientFn;
  }
  return _createMCPClient;
}

async function getStdioTransport(): Promise<typeof _StdioTransport> {
  if (!_StdioTransport) {
    const mod = await import('@ai-sdk/mcp/mcp-stdio');
    _StdioTransport = (mod as Record<string, unknown>).Experimental_StdioMCPTransport as typeof _StdioTransport;
  }
  return _StdioTransport;
}

// ─── Built-in Tools ─────────────────────────────────────────────────

/**
 * Registry of built-in tool factories.
 *
 * Returns raw tool definitions (description + parameters + execute).
 * These are NOT pre-formed AI SDK tools — they use the `parameters` key
 * with plain JSON schema objects. The executor's `buildToolSet()` wraps
 * them with `tool()` + `jsonSchema()` for AI SDK compatibility.
 *
 * IMPORTANT: Do NOT use `inputSchema` or `jsonSchema()` here. That would
 * cause `isAISDKTool()` to falsely classify them as pre-formed tools and
 * skip the `tool()` wrapping, breaking LLM tool presentation.
 */
function createBuiltinTool(name: string): Record<string, unknown> | null {
  switch (name) {
    case 'save_to_memory':
      // The actual persistence is handled by the reducer, not the tool.
      // The tool just captures the key/value pair from the LLM.
      return {
        save_to_memory: {
          description: 'Save data to workflow memory for later use',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Memory key to store the value under' },
              value: { description: 'Value to save (can be any type)' },
            },
            required: ['key', 'value'],
          },
          execute: async (args: Record<string, unknown>) => {
            return { key: args.key, value: args.value, saved: true };
          },
        },
      };
    // Architect tools are handled separately by the agent executor
    // since they need special dependencies (persistence, etc.)
    case 'architect_draft_workflow':
    case 'architect_publish_workflow':
    case 'architect_get_workflow':
      return null; // Handled by architect tool system
    default:
      return null;
  }
}

// ─── MCPConnectionManager ───────────────────────────────────────────

/** Default tool manifest cache TTL: 5 minutes. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Options for constructing an MCPConnectionManager. */
export interface MCPConnectionManagerOptions {
  /**
   * TTL for cached tool manifests in milliseconds.
   * Set to 0 to disable caching (fetch on every resolveTools call).
   * @default 300000 (5 minutes)
   */
  cache_ttl_ms?: number;
  /**
   * Default per-tool execution timeout in milliseconds.
   * Can be overridden per-server via `MCPServerEntry.tool_timeout_ms`.
   * Set to 0 to disable (no timeout). @default 30000 (30 seconds)
   */
  default_tool_timeout_ms?: number;
  /**
   * Per-tool circuit breaker tuning. Pass `null` to disable per-tool breakers
   * entirely (the connection-level retry still applies). Omit to use defaults
   * (5 consecutive failures → 30s cooldown → 2 successes to close).
   */
  tool_circuit_breaker?: ToolCircuitBreakerOptions | null;
  /**
   * Default cap on concurrent tool calls per MCP server. Overridable per-server
   * via `MCPServerEntry.max_concurrent_calls`. `0` (default) means unlimited —
   * set a finite value to protect servers from wide fan-out.
   * @default 0 (unlimited)
   */
  default_max_concurrent_calls?: number;
}

/** Cached tool manifest entry. */
interface ToolCacheEntry {
  tools: Record<string, unknown>;
  fetchedAt: number;
}

/**
 * Manages MCP client connections for a workflow run.
 *
 * Create one per GraphRunner.run() invocation. Call closeAll() when done.
 */
export class MCPConnectionManager implements ToolResolver {
  private readonly clients = new Map<string, MCPClientType>();
  private readonly pending = new Map<string, Promise<MCPClientType>>();
  private readonly registry: MCPServerRegistry;
  // Process-wide fallback accumulator (used when drainTaintEntries() is
  // called without a toolset handle).
  private taintEntries = new Map<string, TaintMetadata>();
  // Per-resolution taint collectors, keyed by the toolset object returned
  // from resolveTools(). A WeakMap so collectors are GC'd with their tools.
  // This is what makes concurrent executions race-free: each gets its own
  // collector, and drainTaintEntries(tools) retrieves exactly that one.
  private readonly taintByToolset = new WeakMap<object, Map<string, TaintMetadata>>();
  private readonly toolCache = new Map<string, ToolCacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly defaultToolTimeoutMs: number;
  /**
   * Per-tool circuit breaker. `null` means the operator explicitly disabled
   * breakers via `tool_circuit_breaker: null` in the options; tool execution
   * skips the check/record path entirely in that case.
   */
  private readonly toolBreakers: ToolCircuitBreakerManager | null;
  /** Per-server concurrency limiters, keyed by serverId. Absent → unlimited. */
  private readonly serverSemaphores = new Map<string, Semaphore>();
  private readonly defaultMaxConcurrentCalls: number;

  constructor(registry: MCPServerRegistry, options?: MCPConnectionManagerOptions) {
    this.registry = registry;
    this.cacheTtlMs = options?.cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS;
    this.defaultToolTimeoutMs = options?.default_tool_timeout_ms ?? 30_000;
    this.defaultMaxConcurrentCalls = options?.default_max_concurrent_calls ?? 0;
    this.toolBreakers = options?.tool_circuit_breaker === null
      ? null
      : new ToolCircuitBreakerManager(options?.tool_circuit_breaker ?? undefined);
  }

  /**
   * Resolve (and lazily create) the concurrency limiter for a server. Returns
   * `undefined` when the effective limit is unlimited (`0`), so the hot path
   * stays allocation-free for the common case.
   */
  private getServerSemaphore(serverId: string, entry: MCPServerEntry): Semaphore | undefined {
    const limit = entry.max_concurrent_calls ?? this.defaultMaxConcurrentCalls;
    if (!limit || limit < 1) return undefined;
    let sem = this.serverSemaphores.get(serverId);
    if (!sem) {
      sem = new Semaphore(limit);
      this.serverSemaphores.set(serverId, sem);
    }
    return sem;
  }

  /**
   * Snapshot of every per-tool breaker tracked by this manager.
   * Use for `/metrics` endpoints, dashboards, or asserting in tests.
   * Returns an empty array if breakers are disabled.
   */
  getToolCircuitMetrics(): ToolCircuitBreakerMetrics[] {
    return this.toolBreakers?.getMetrics() ?? [];
  }

  /**
   * Resolve tool sources into a merged AI SDK tool set.
   *
   * Built-in tools are resolved synchronously.
   * MCP tools are resolved by connecting to the registered server.
   */
  async resolveTools(sources: ToolSource[], agentId?: string): Promise<Record<string, unknown>> {
    const tools: Record<string, unknown> = {};
    // Fresh per-resolution taint collector — wrapped tools below write into
    // THIS map, so concurrent resolveTools()/execute()/drain() cycles never
    // cross-attribute taint (registered against `tools` at the end).
    const collector = new Map<string, TaintMetadata>();
    const mcpToolSets: Array<{ serverId: string; toolSet: Record<string, unknown>; filter?: string[]; toolTimeoutMs: number; semaphore?: Semaphore }> = [];

    // Separate built-in and MCP sources
    const mcpSources = sources.filter(s => s.type === 'mcp');
    const builtinSources = sources.filter(s => s.type === 'builtin');

    // Resolve built-ins synchronously
    for (const source of builtinSources) {
      const builtinTools = createBuiltinTool(source.name);
      if (builtinTools) {
        Object.assign(tools, builtinTools);
      }
    }

    // Resolve MCP tools in parallel (with access control + caching)
    if (mcpSources.length > 0) {
      const results = await Promise.all(
        mcpSources.map(async (source) => {
          const entry = await this.checkAccess(source.server_id, agentId);
          const toolSet = await this.getToolsForServer(source.server_id);
          const toolTimeoutMs = entry.tool_timeout_ms ?? this.defaultToolTimeoutMs;
          const semaphore = this.getServerSemaphore(source.server_id, entry);
          return { serverId: source.server_id, toolSet, filter: source.tool_names, toolTimeoutMs, semaphore };
        })
      );

      for (const result of results) {
        mcpToolSets.push(result);
      }
    }

    // Merge MCP tools with collision detection
    const allToolNames = new Map<string, string[]>(); // toolName → [serverIds]

    for (const { serverId, toolSet, filter } of mcpToolSets) {
      // Least-privilege: without an explicit `tool_names` allowlist, the agent
      // receives EVERY tool the server currently advertises — including any a
      // compromised/updated server later injects (confused-deputy / privilege
      // creep). Warn so this is an observable decision rather than silent.
      if (!filter || filter.length === 0) {
        logger.warn('mcp_tool_allowlist_absent', {
          server_id: serverId,
          granted_tool_count: Object.keys(toolSet).length,
          hint: 'set tool_names to restrict which server tools this agent may call',
        });
      }
      const toolNames = filter ?? Object.keys(toolSet);
      for (const name of toolNames) {
        // hasOwnProperty (not `in`): a `tool_names` entry of "toString" /
        // "constructor" must not match an inherited prototype member.
        if (!Object.prototype.hasOwnProperty.call(toolSet, name)) {
          logger.warn('filtered_tool_not_found', { server_id: serverId, tool_name: name });
          continue;
        }
        const existing = allToolNames.get(name) ?? [];
        existing.push(serverId);
        allToolNames.set(name, existing);
      }
    }

    // Detect collisions
    const collisions = new Set<string>();
    for (const [name, serverIds] of allToolNames) {
      if (serverIds.length > 1 || (name in tools)) {
        collisions.add(name);
      }
    }

    // Add MCP tools with taint wrapping, timeout, and optional namespacing
    for (const { serverId, toolSet, filter, toolTimeoutMs, semaphore } of mcpToolSets) {
      const toolNames = filter ?? Object.keys(toolSet);
      for (const name of toolNames) {
        if (!Object.prototype.hasOwnProperty.call(toolSet, name)) continue;

        const tool = toolSet[name] as Record<string, unknown>;
        const wrappedTool = this.wrapToolWithTaint(tool, name, serverId, toolTimeoutMs, collector, semaphore);
        const finalName = collisions.has(name) ? `${serverId}__${name}` : name;

        if (collisions.has(name)) {
          logger.info('tool_namespaced', { tool_name: name, server_id: serverId, namespaced_as: finalName });
        }

        tools[finalName] = wrappedTool;
      }
    }

    // Register the collector against this toolset so drainTaintEntries(tools)
    // can retrieve exactly this execution's entries (even if empty).
    this.taintByToolset.set(tools, collector);

    return tools;
  }

  /**
   * Get tool manifests for a server, using cache if valid.
   */
  private async getToolsForServer(serverId: string): Promise<Record<string, unknown>> {
    if (this.cacheTtlMs > 0) {
      const cached = this.toolCache.get(serverId);
      if (cached && (Date.now() - cached.fetchedAt) < this.cacheTtlMs) {
        logger.debug('tool_cache_hit', { server_id: serverId });
        return cached.tools;
      }
    }

    const client = await this.getClient(serverId);
    const tools = await client.tools() as Record<string, unknown>;

    if (this.cacheTtlMs > 0) {
      this.toolCache.set(serverId, { tools, fetchedAt: Date.now() });
    }

    return tools;
  }

  /**
   * Get or create an MCP client for a server ID.
   * Uses pending-promise dedup to prevent connection stampedes.
   * Retries failed connections with exponential backoff.
   */
  private async getClient(serverId: string): Promise<MCPClientType> {
    // Return existing connected client
    const existing = this.clients.get(serverId);
    if (existing) return existing;

    // Join pending connection if one exists
    const pending = this.pending.get(serverId);
    if (pending) return pending;

    // Start new connection with retry
    const connectionPromise = this.connectWithRetry(serverId);
    this.pending.set(serverId, connectionPromise);

    try {
      const client = await connectionPromise;
      this.clients.set(serverId, client);
      return client;
    } finally {
      this.pending.delete(serverId);
    }
  }

  /**
   * Connect with retry and exponential backoff.
   */
  private async connectWithRetry(serverId: string): Promise<MCPClientType> {
    const entry = await this.registry.loadServer(serverId);
    if (!entry) {
      throw new MCPServerNotFoundError(serverId);
    }

    const maxRetries = entry.max_retries ?? 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.connectToServer(serverId);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10_000);
          logger.warn('connection_retry', {
            server_id: serverId,
            attempt: attempt + 1,
            max_retries: maxRetries,
            backoff_ms: backoffMs,
            error: lastError.message,
          });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError!;
  }

  /**
   * Remove a client and invalidate its cache, forcing reconnection on next use.
   */
  async reconnect(serverId: string): Promise<void> {
    const existing = this.clients.get(serverId);
    if (existing) {
      try {
        await existing.close();
      } catch {
        // Best-effort close
      }
      this.clients.delete(serverId);
    }
    this.toolCache.delete(serverId);
    logger.info('connection_invalidated', { server_id: serverId });
  }

  /**
   * Check if an agent is authorized to use an MCP server.
   * If `allowed_agents` is set on the server entry, the agent must be in the list.
   * Returns the server entry for downstream use.
   */
  private async checkAccess(serverId: string, agentId?: string): Promise<MCPServerEntry> {
    const entry = await this.registry.loadServer(serverId);
    if (!entry) {
      throw new MCPServerNotFoundError(serverId);
    }

    if (entry.allowed_agents && entry.allowed_agents.length > 0) {
      if (!agentId || !entry.allowed_agents.includes(agentId)) {
        throw new MCPAccessDeniedError(agentId ?? 'unknown', serverId);
      }
    }

    return entry;
  }

  /**
   * Connect to an MCP server by looking up its config in the registry.
   */
  private async connectToServer(serverId: string): Promise<MCPClientType> {
    const entry = await this.registry.loadServer(serverId);
    if (!entry) {
      throw new MCPServerNotFoundError(serverId);
    }

    const transport = await this.buildTransport(entry);
    const createClient = await getCreateMCPClient();

    logger.info('connecting', { server_id: serverId, transport_type: entry.transport.type });

    const client = await createClient({
      transport,
      name: `mcai-${serverId}`,
      onUncaughtError: (error) => {
        logger.error('uncaught_mcp_error', error as Error, { server_id: serverId });
      },
    });

    logger.info('connected', { server_id: serverId });
    return client;
  }

  /**
   * Build an @ai-sdk/mcp transport config from our registry entry.
   */
  private async buildTransport(entry: MCPServerEntry): Promise<unknown> {
    const config = entry.transport;

    switch (config.type) {
      case 'stdio': {
        // Defense-in-depth: never spawn a stdio process when the hosted lockdown
        // is on, even if a stdio server row slipped past schema validation
        // (e.g. persisted before the flag was set).
        if (isStdioMcpDisabled()) {
          throw new Error(
            'stdio MCP transports are disabled in this deployment (MCP_STDIO_DISABLED). Use an http or sse transport.',
          );
        }
        const StdioTransportClass = await getStdioTransport();
        if (!StdioTransportClass) {
          throw new Error('Stdio transport requires @ai-sdk/mcp/mcp-stdio — is @ai-sdk/mcp installed?');
        }
        const { env: safeEnv, dropped } = scrubStdioEnv(config.env);
        if (dropped.length > 0) {
          logger.warn('mcp_stdio_env_scrubbed', { server_id: entry.id, dropped });
        }
        return new StdioTransportClass({
          command: config.command,
          args: config.args,
          env: {
            ...safeEnv,
            // Suppress npm install/fund/audit output that npx writes to stdout,
            // which corrupts the JSON-RPC stdio transport.
            npm_config_loglevel: 'silent',
          },
        });
      }
      case 'http':
        await assertHostResolvesPublic(config.url, entry.id);
        return {
          type: 'http' as const,
          url: config.url,
          headers: config.headers,
        };
      case 'sse':
        await assertHostResolvesPublic(config.url, entry.id);
        return {
          type: 'sse' as const,
          url: config.url,
          headers: config.headers,
        };
    }
  }

  /**
   * Wrap a tool's execute function to:
   * 1. Enforce per-tool execution timeouts
   * 2. Accumulate taint metadata for provenance tracking
   *
   * Creates a new tool object — never mutates the original.
   */
  private wrapToolWithTaint(
    tool: Record<string, unknown>,
    toolName: string,
    serverId: string,
    toolTimeoutMs: number = 0,
    collector?: Map<string, TaintMetadata>,
    semaphore?: Semaphore,
  ): Record<string, unknown> {
    const originalExecute = tool.execute as ((args: unknown) => Promise<unknown>) | undefined;

    if (!originalExecute) {
      return { ...tool };
    }

    // The timeout-raced invocation, factored out so it can run inside the
    // per-server concurrency permit when one is configured.
    const invoke = async (args: unknown): Promise<unknown> => {
      if (toolTimeoutMs > 0) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), toolTimeoutMs);
        try {
          return await Promise.race([
            originalExecute(args),
            new Promise<never>((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error(`MCP tool "${toolName}" on server "${serverId}" timed out after ${toolTimeoutMs}ms`));
              }, { once: true });
            }),
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
      }
      return originalExecute(args);
    };

    return {
      ...tool,
      execute: async (args: unknown): Promise<unknown> => {
        // Refuse execution upfront if the per-tool breaker is open.
        // Throws ToolCircuitBreakerOpenError; the agent executor catches the
        // tool error and surfaces it to the LLM as a normal tool-call failure.
        // Checked BEFORE acquiring a permit so a tripped breaker fails fast
        // without occupying a concurrency slot.
        this.toolBreakers?.check(serverId, toolName);

        let result: unknown;
        try {
          // Hold a per-server permit for the duration of the call (including
          // the timeout window) so wide fan-out can't overwhelm one server.
          result = semaphore ? await semaphore.run(() => invoke(args)) : await invoke(args);
        } catch (err) {
          this.toolBreakers?.recordFailure(serverId, toolName);
          // A throwing server still delivers attacker-influencable text (its
          // error message) into the agent's LLM context, which the agent can
          // fold into its output. Taint it exactly like a successful result —
          // otherwise strict_taint / securityPolicy gates never fire on
          // injection smuggled through a tool error.
          this.recordTaint(collector, serverId, toolName);
          throw err;
        }

        this.toolBreakers?.recordSuccess(serverId, toolName);

        // Bound the result size. A malicious/compromised server returning a
        // multi-GB payload would otherwise be held in memory, fed into the LLM
        // context, AND copied into the event log — a worker OOM that can take
        // out co-tenant runs. Capping here stops all three.
        result = MCPConnectionManager.enforceResultSize(result, toolName, serverId);

        this.recordTaint(collector, serverId, toolName);
        return result;
      },
    };
  }

  /**
   * Record a taint entry for a `serverId:toolName` source in both the
   * per-resolution collector (race-free attribution) and the process-wide map
   * (so a no-arg {@link drainTaintEntries} still works). Called on BOTH the
   * success and error paths — a tool error is an external-data source too.
   */
  private recordTaint(
    collector: Map<string, TaintMetadata> | undefined,
    serverId: string,
    toolName: string,
  ): void {
    const taintKey = `${serverId}:${toolName}`;
    const entry = {
      source: 'mcp_tool' as const,
      tool_name: toolName,
      server_id: serverId,
      created_at: new Date().toISOString(),
    };
    (collector ?? this.taintEntries).set(taintKey, entry);
    this.taintEntries.set(taintKey, entry);
  }

  /** Maximum serialized bytes accepted from a single MCP tool result. */
  private static readonly MAX_RESULT_BYTES = 10 * 1024 * 1024; // 10 MB

  /**
   * Enforce {@link MAX_RESULT_BYTES} on a tool result. Oversized or
   * unserializable results are replaced with a small error marker (surfaced to
   * the LLM as a normal tool failure) instead of being propagated.
   */
  private static enforceResultSize(result: unknown, toolName: string, serverId: string): unknown {
    let bytes: number;
    if (typeof result === 'string') {
      bytes = result.length;
    } else {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(result);
      } catch {
        logger.warn('mcp_tool_result_unserializable', { server_id: serverId, tool_name: toolName });
        return { error: `MCP tool "${toolName}" returned an unserializable result and was dropped.` };
      }
      bytes = serialized?.length ?? 0;
    }

    if (bytes > MCPConnectionManager.MAX_RESULT_BYTES) {
      logger.warn('mcp_tool_result_oversized', {
        server_id: serverId,
        tool_name: toolName,
        bytes,
        cap: MCPConnectionManager.MAX_RESULT_BYTES,
      });
      return {
        error:
          `MCP tool "${toolName}" result (${bytes} bytes) exceeded the ` +
          `${MCPConnectionManager.MAX_RESULT_BYTES}-byte limit and was dropped to protect worker memory.`,
      };
    }
    return result;
  }

  /**
   * Drain accumulated taint entries from MCP tool executions.
   *
   * Pass the toolset returned by the paired `resolveTools()` call to drain
   * ONLY that execution's entries (race-free under concurrency). With no
   * argument, drains the process-wide accumulator (legacy behavior).
   *
   * @param tools - The exact toolset object from `resolveTools()`.
   */
  drainTaintEntries(tools?: Record<string, unknown>): Map<string, TaintMetadata> {
    if (tools) {
      const collector = this.taintByToolset.get(tools);
      if (collector) {
        const entries = new Map(collector);
        collector.clear();
        return entries;
      }
    }
    const entries = new Map(this.taintEntries);
    this.taintEntries.clear();
    return entries;
  }

  /**
   * Close all open MCP client connections.
   */
  async closeAll(): Promise<void> {
    const closePromises = [...this.clients.entries()].map(async ([serverId, client]) => {
      try {
        await client.close();
        logger.info('disconnected', { server_id: serverId });
      } catch (error) {
        logger.error('close_failed', error as Error, { server_id: serverId });
      }
    });

    await Promise.allSettled(closePromises);
    this.clients.clear();
    this.pending.clear();
    this.toolCache.clear();
  }
}

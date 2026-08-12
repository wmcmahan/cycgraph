/**
 * A2A Server Registry Schema
 *
 * Trusted store of the remote agents a graph may delegate to, mirroring the
 * MCP server registry. A graph never carries an endpoint URL or a
 * credential; it names a `server_id` and the registry resolves it at run
 * time. That indirection is the whole point: an LLM-authored or
 * user-supplied graph cannot point the engine at an arbitrary host, and
 * cannot read the credentials used to reach one.
 *
 * Validation runs on every registry read AND write, so a row written
 * through a compromised admin path or an older schema is rejected when it
 * is loaded rather than trusted because it is already stored.
 *
 * @module a2a/schema
 */

import { z } from 'zod';
import { isPrivateOrLoopbackHost } from '../tools/schema.js';
import type { Camelize } from '../utils/case-mapping.js';

/**
 * SSRF guard for Agent Card URLs.
 *
 * Same reasoning as the MCP transport guard, and a deliberately SEPARATE
 * opt-out. An operator who allowed private MCP URLs so a local server could
 * run has not thereby agreed that graphs may call agents on localhost or
 * cloud metadata endpoints. Two protocols, two decisions.
 */
function safeAgentCardUrl() {
  return z.string().url().superRefine((value, ctx) => {
    if (process.env.CYCGRAPH_ALLOW_PRIVATE_A2A_URLS === 'true') return;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return; // .url() already reported the format error
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A2A agent card URL must use http(s), got "${parsed.protocol}"`,
      });
      return;
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `A2A agent card URL host "${parsed.hostname}" is private/loopback/link-local and is blocked (SSRF guard). ` +
          `Set CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true to allow it in development.`,
      });
    }
  });
}

/**
 * How to authenticate to a remote agent.
 *
 * Credentials are named, never inlined: an entry stores the NAME of an
 * environment variable and the value is read at call time. A registry row
 * therefore holds no secret, so a database dump, a log line, or a
 * `listServers()` response cannot leak one.
 *
 * The limitation is deliberate and worth stating: a multi-tenant deployment
 * holding per-tenant credentials in a database cannot express that here.
 * Extending this union is the intended path, rather than relaxing it to
 * accept literal tokens.
 */
export const A2AAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('bearer'),
    /** Env var holding the bearer token. */
    token_env: z.string().min(1),
  }),
  z.object({
    type: z.literal('header'),
    /** Header name to send, e.g. `x-api-key`. */
    header: z.string().min(1),
    /** Env var holding the header value. */
    value_env: z.string().min(1),
  }),
]);

export type A2AAuth = z.infer<typeof A2AAuthSchema>;

/**
 * A registered A2A server entry.
 *
 * Stored in the trusted A2A Server Registry. Only administrators create or
 * modify entries; graphs reference servers by `id`.
 */
export const A2AServerEntrySchema = z.object({
  /** Unique server identifier, referenced from `a2a_config.server_id`. */
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
  /** Human-readable name. */
  name: z.string(),
  /** Optional description of what this agent does. */
  description: z.string().optional(),
  /** URL of the agent's published Agent Card. */
  agent_card_url: safeAgentCardUrl(),
  /** How to authenticate. Defaults to unauthenticated. */
  auth: A2AAuthSchema.default({ type: 'none' }),
  /** Agent IDs allowed to use this server. Omit for unrestricted access. */
  allowed_agents: z.array(z.string()).optional(),
  /** Connection timeout in milliseconds. */
  timeout_ms: z.number().int().positive().max(3_600_000).default(30_000),
  /**
   * How long to wait for a task to reach a terminal or interrupted state.
   * Distinct from `timeout_ms`, which bounds a single request: a remote task
   * can legitimately run far longer than any one call to it.
   */
  task_timeout_ms: z.number().int().positive().max(86_400_000).default(600_000),
  /**
   * Max concurrent tasks in flight against this server. Bounds fan-out so a
   * map or voting node cannot overwhelm one remote agent.
   */
  max_concurrent_tasks: z.number().int().positive().optional(),
  /** Maximum connection retries before giving up. */
  max_retries: z.number().int().min(0).max(10).default(2),
  /**
   * Send W3C `traceparent` so this server's work joins our trace.
   *
   * Off by default: it discloses our trace id to a third party, which is
   * routine inside one system and a deliberate choice across an
   * organisational boundary. Turn it on for servers you operate or trust.
   */
  propagate_trace_context: z.boolean().default(false),
});

export type A2AServerEntry = z.infer<typeof A2AServerEntrySchema>;

/**
 * Authoring input: camelCase, like every registry in this codebase. The
 * in-memory registry remaps to the snake_case wire shape before the
 * security-critical parse, and the remap is idempotent so snake_case
 * callers keep working. `z.input` rather than `z.infer`, so fields with
 * schema defaults stay optional at the call site.
 */
export type A2AServerConfig = Camelize<z.input<typeof A2AServerEntrySchema>>;

/**
 * Registry for resolving A2A servers.
 *
 * Decoupled from any specific store, exactly like {@link MCPServerRegistry}.
 * Implementations MUST parse through {@link A2AServerEntrySchema} on read as
 * well as write, so the SSRF guard and credential rules cannot be bypassed
 * by writing the table directly.
 */
export interface A2AServerRegistry {
  /** Register or update a server entry. */
  saveServer(entry: A2AServerConfig): Promise<void>;

  /** Load a server by ID. Returns `null` if not found. */
  loadServer(id: string): Promise<A2AServerEntry | null>;

  /** List all registered servers. */
  listServers(): Promise<A2AServerEntry[]>;

  /** Remove a server by ID. Returns `true` if it existed. */
  deleteServer(id: string): Promise<boolean>;
}

/**
 * Resolve an entry's auth to request headers, reading env at call time.
 *
 * Returns an empty object for `none`, and throws when a named variable is
 * absent: failing loudly at the boundary beats sending an unauthenticated
 * request and reading a 401 three retries later.
 */
export function resolveAuthHeaders(auth: A2AAuth): Record<string, string> {
  switch (auth.type) {
    case 'none':
      return {};
    case 'bearer': {
      const token = process.env[auth.token_env];
      if (!token) throw new A2ACredentialError(auth.token_env);
      return { authorization: `Bearer ${token}` };
    }
    case 'header': {
      const value = process.env[auth.value_env];
      if (!value) throw new A2ACredentialError(auth.value_env);
      return { [auth.header]: value };
    }
  }
}

/** Thrown when an entry names an environment variable that is not set. */
export class A2ACredentialError extends Error {
  constructor(public readonly variable: string) {
    super(
      `A2A server credential unavailable: environment variable "${variable}" is not set. ` +
      `The registry entry names it, so the value must be present at call time.`,
    );
    this.name = 'A2ACredentialError';
  }
}

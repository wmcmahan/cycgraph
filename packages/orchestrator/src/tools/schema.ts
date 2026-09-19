/**
 * Tool Source Types — MCP Server Registry & Agent Tool Declarations
 *
 * Defines the structured tool source system.
 *
 * @module tools/schema
 */

import { z } from 'zod';
import type { Camelize } from '../utils/case-mapping.js';
import type { DefinedTool } from '../tools/define-tool.js';

// ─── Tool Source (Agent Config Level) ──────────────────────────────

/**
 * Known built-in tool names.
 * These are handled directly by the orchestrator without MCP.
 */
export const BUILTIN_TOOL_NAMES = [
  'save_to_memory',
  'architect_draft_workflow',
  'architect_publish_workflow',
  'architect_get_workflow',
] as const;

/**
 * A built-in tool provided by the orchestrator itself (not via MCP).
 */
export const BuiltinToolSourceSchema = z.object({
  type: z.literal('builtin'),
  name: z.enum(BUILTIN_TOOL_NAMES),
});

/**
 * A tool provided by a registered MCP server.
 *
 * References a server by ID (never contains transport config).
 * Optionally filters to specific tool names from that server.
 */
export const MCPToolSourceSchema = z.object({
  type: z.literal('mcp'),
  server_id: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'server_id must be alphanumeric, hyphens, or underscores'),
  tool_names: z.array(z.string()).optional(),
});

/**
 * A host-registered custom tool, referenced by name.
 *
 * The implementation is injected at runtime via `GraphRunnerOptions.tools`
 * (a `defineTool()` result); the graph carries only this serializable
 * reference. Unresolvable names fail the runner's preflight wiring check.
 */
export const CustomToolSourceSchema = z.object({
  type: z.literal('custom'),
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'custom tool name must be alphanumeric, hyphens, or underscores'),
});

/**
 * Discriminated union of tool source types.
 *
 * Agents declare their tool requirements as `ToolSource[]`.
 * Resolution happens at execution time via the runner's composed tool
 * resolution (built-ins, `defineTool()` registrations, and MCP resolvers).
 */
export const ToolSourceSchema = z.discriminatedUnion('type', [
  BuiltinToolSourceSchema,
  MCPToolSourceSchema,
  CustomToolSourceSchema,
]);

export type ToolSource = z.infer<typeof ToolSourceSchema>;

// ─── Authoring Sugar ───────────────────────────────────────────────

/**
 * Lightweight authoring shorthand for an MCP tool source: `mcp` is the
 * registered server id, `tools` the optional tool-name allowlist.
 * (`tool_names` is accepted because camelCase authoring of `toolNames`
 * arrives in that form after the case remap.)
 */
const MCPShorthandSchema = z.object({
  mcp: z.string().min(1),
  tools: z.array(z.string()).optional(),
  tool_names: z.array(z.string()).optional(),
});

/**
 * Structural check for a `defineTool()` result: a named object carrying an
 * `execute` function. Inlined (rather than imported from `tools/define-tool`)
 * because that module value-imports {@link BUILTIN_TOOL_NAMES} from here. A
 * value import back would create a runtime cycle.
 */
function isDefinedToolShape(value: unknown): value is DefinedTool {
  if (value === null || typeof value !== 'object') return false;
  const tool = value as Partial<DefinedTool>;
  return typeof tool.name === 'string' && typeof tool.execute === 'function';
}

/**
 * Normalize an authoring-sugar tool source to the structured wire form.
 * Strings resolve locally: names in {@link BUILTIN_TOOL_NAMES} become
 * `builtin` sources, everything else `custom`. `{ mcp: id }` objects become
 * `mcp` sources. A `defineTool()` result collapses to its serializable
 * `{ type: 'custom', name }` reference — the implementation itself is never
 * stored; the authoring facade stashes it for `run()`, and raw-API callers
 * pass it to `GraphRunnerOptions.tools`. Already-structured objects pass
 * through for the piped {@link ToolSourceSchema} to validate.
 */
function normalizeToolSourceInput(value: unknown): unknown {
  if (typeof value === 'string') {
    return (BUILTIN_TOOL_NAMES as readonly string[]).includes(value)
      ? { type: 'builtin', name: value }
      : { type: 'custom', name: value };
  }
  if (isDefinedToolShape(value)) {
    return { type: 'custom', name: value.name };
  }
  if (value !== null && typeof value === 'object' && 'mcp' in value && !('type' in value)) {
    const shorthand = value as z.infer<typeof MCPShorthandSchema>;
    const filter = shorthand.tools ?? shorthand.tool_names;
    return {
      type: 'mcp',
      server_id: shorthand.mcp,
      ...(filter ? { tool_names: filter } : {}),
    };
  }
  return value;
}

/**
 * Tool-source schema for authoring boundaries (`createGraph`, agent config
 * parsing). Accepts the sugar forms — a bare tool name, an `{ mcp: id }`
 * server ref — alongside the structured wire form, and always OUTPUTS the
 * structured {@link ToolSource}, so everything stored or persisted stays in
 * wire format regardless of how it was authored.
 */
export const ToolSourceInputSchema = z
  .union([
    z.string().min(1),
    z.custom<DefinedTool>(isDefinedToolShape),
    MCPShorthandSchema,
    ToolSourceSchema,
  ])
  .transform(normalizeToolSourceInput)
  .pipe(ToolSourceSchema);

/**
 * What authors may write wherever a tool source is expected: a local tool
 * name, a `defineTool()` result (collapsed to its `{ type: 'custom', name }`
 * reference), an MCP server shorthand, or the structured form in either
 * casing (the camelCase variant is remapped by the authoring-boundary
 * constructors before the schema parses it).
 */
export type ToolSourceInput =
  | string
  | DefinedTool
  | { mcp: string; tools?: string[]; toolNames?: string[] }
  | ToolSource
  | ToolSourceConfig;

/**
 * Normalize an array of authored tool sources to wire format. Used by agent
 * registries at the write boundary so persisted configs always store the
 * structured form, never the sugar.
 */
export function normalizeToolSources(tools: unknown): ToolSource[] {
  return z.array(ToolSourceInputSchema).parse(tools);
}

/**
 * camelCase authoring type for tool sources (`serverId`, `toolNames`), derived
 * from the snake_case {@link ToolSource} wire type. Used when authoring node /
 * agent `tools`; the constructors remap to snake_case for the engine.
 */
export type ToolSourceConfig = Camelize<ToolSource>;
export type BuiltinToolSource = z.infer<typeof BuiltinToolSourceSchema>;
export type MCPToolSource = z.infer<typeof MCPToolSourceSchema>;
export type CustomToolSource = z.infer<typeof CustomToolSourceSchema>;

// ─── MCP Transport Configs (Registry Level) ────────────────────────

/** Allowed commands for stdio transports (security: no arbitrary execution). */
const ALLOWED_STDIO_COMMANDS = ['npx', 'node', 'python3', 'python', 'uvx'] as const;

/**
 * Whether stdio MCP transports are disabled for this deployment.
 *
 * Default `false` (stdio allowed) for single-tenant / OSS / self-host, where a
 * stdio server runs on the user's own machine. Set `MCP_STDIO_DISABLED=true` in
 * a HOSTED / multi-tenant deployment: a tenant-registered stdio server spawns an
 * arbitrary process (`npx`/`uvx`/… — the allowlist limits the *binary*, not what
 * it does) on a SHARED worker, i.e. code execution across tenants. http/sse
 * transports (SSRF-guarded) remain available. Read at validation/connect time.
 */
export function isStdioMcpDisabled(): boolean {
  return process.env.MCP_STDIO_DISABLED === 'true';
}

/**
 * SSRF guard for MCP transport URLs.
 *
 * MCP server URLs come from a trusted registry, but a registry write from a
 * compromised admin path, a misconfiguration, or an architect-style tool
 * must not be able to point the MCP client at internal infrastructure
 * (cloud metadata endpoints, localhost services, RFC1918 hosts). We reject
 * non-http(s) schemes and private / loopback / link-local / unspecified
 * hosts by default.
 *
 * Escape hatch: set `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true` for local
 * development where MCP servers genuinely run on localhost. This is
 * deliberately an env var (operator decision), never agent-reachable.
 *
 * Note: this blocks literal private-IP and loopback hosts. It does NOT
 * defend against DNS rebinding (a public name resolving to a private IP at
 * connect time) — pair with network egress policy for that.
 */
/** Range-check a canonical dotted-quad IPv4 against private/loopback/link-local ranges. */
function isPrivateIpv4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 127) return true;                       // loopback 127.0.0.0/8
  if (a === 10) return true;                         // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // private 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // private 192.168.0.0/16
  if (a === 169 && b === 254) return true;           // link-local (incl. metadata 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 0) return true;                          // unspecified 0.0.0.0/8
  return false;
}

/**
 * Parse ANY integer encoding of an IPv4 address into canonical octets.
 *
 * `getaddrinfo` (and thus Node's socket layer) accepts non-dotted-quad forms:
 * decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), and short
 * dotted forms (`127.1`). A guard that only matches `d.d.d.d` is trivially
 * bypassed — `http://2130706433/` still resolves to 127.0.0.1. Canonicalize
 * first, then range-check. Returns `null` if the host is not an IPv4 literal.
 */
function canonicalizeIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p) || p === '0') n = parseInt(p, 10);
    else return null; // non-numeric part → not an IPv4 literal (a real hostname)
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }

  // inet_aton semantics: the final part fills all remaining low octets.
  const lead = nums.slice(0, -1);
  const last = nums[nums.length - 1];
  if (lead.some((x) => x > 255)) return null;
  if (last >= Math.pow(256, 4 - lead.length)) return null;

  let value = last;
  for (let i = 0; i < lead.length; i++) value += lead[i] * Math.pow(256, 3 - i);
  value = value >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * Parse one colon-separated run of IPv6 groups into 16-bit values.
 *
 * A trailing dotted form in the last position is an embedded IPv4 and
 * contributes the two groups it occupies. Returns `null` on any part that is
 * not a valid group.
 */
function parseIpv6Groups(run: string): number[] | null {
  if (run === '') return [];
  const parts = run.split(':');
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === parts.length - 1 && part.includes('.')) {
      const octets = canonicalizeIpv4(part);
      if (!octets) return null;
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups.
 *
 * `getaddrinfo` accepts every RFC 4291 spelling of one address, so a guard
 * that prefix-matches strings waves through `0:0:0:0:0:0:0:1` and
 * `0:0:0:0:0:ffff:7f00:1` while the socket layer still reaches loopback.
 * Canonicalize first, then range-check. A zone id (`fe80::1%eth0`) is
 * dropped — it selects an interface, not an address. Returns `null` if the
 * host is not a well-formed IPv6 literal.
 */
function canonicalizeIpv6(host: string): number[] | null {
  const bare = host.split('%')[0];
  if (!bare.includes(':')) return null;

  const runs = bare.split('::');
  if (runs.length > 2) return null;

  const head = parseIpv6Groups(runs[0]);
  if (head === null) return null;
  if (runs.length === 1) return head.length === 8 ? head : null;

  const tail = parseIpv6Groups(runs[1]);
  if (tail === null) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

/**
 * The IPv4 address an IPv6 group array embeds in its low 32 bits, for the
 * prefixes whose traffic a stack forwards to that IPv4 target: IPv4-mapped
 * (`::ffff:0:0/96`), IPv4-translated (`::ffff:0:0:0/96`), the deprecated
 * IPv4-compatible (`::/96`), and the NAT64 well-known prefix
 * (`64:ff9b::/96`). Returns `null` when no IPv4 is embedded.
 */
function embeddedIpv4(groups: number[]): [number, number, number, number] | null {
  const prefixIsZero = (upTo: number) => groups.slice(0, upTo).every((g) => g === 0);
  const embeds =
    (prefixIsZero(5) && groups[5] === 0xffff) ||                                  // ::ffff:a.b.c.d
    (prefixIsZero(4) && groups[4] === 0xffff && groups[5] === 0) ||               // ::ffff:0:a.b.c.d
    prefixIsZero(6) ||                                                            // ::a.b.c.d
    (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0));
  if (!embeds) return null;
  return [(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff];
}

/** Range-check canonical IPv6 groups against loopback/unspecified/link-local/ULA. */
function isPrivateIpv6(groups: number[]): boolean {
  if (groups.every((g) => g === 0)) return true;                                 // unspecified ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;  // loopback ::1
  if ((groups[0] & 0xffc0) === 0xfe80) return true;                              // link-local fe80::/10
  if ((groups[0] & 0xfe00) === 0xfc00) return true;                              // unique-local fc00::/7

  const mapped = embeddedIpv4(groups);
  if (mapped) return isPrivateIpv4(mapped[0], mapped[1], mapped[2], mapped[3]);

  return false;
}

/**
 * True when a host is private / loopback / link-local / unique-local /
 * unspecified. Accepts a hostname or a literal IP in any encoding (dotted or
 * integer IPv4, bracketed or bare IPv6 in any RFC 4291 spelling, with or
 * without a zone id). Exported so the connection manager can re-check
 * DNS-*resolved* addresses at connect time — the parse-time schema guard only
 * sees the literal hostname string and cannot catch a public name that
 * resolves to a private IP (DNS rebinding).
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  // URL.hostname keeps IPv6 in brackets — strip them.
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const octets = canonicalizeIpv4(host);
  if (octets) return isPrivateIpv4(octets[0], octets[1], octets[2], octets[3]);

  if (host.includes(':')) {
    const groups = canonicalizeIpv6(host);
    // Fail closed: a colon never appears in a DNS name, so an IPv6 literal
    // this guard cannot canonicalize is treated as private rather than
    // trusted — the socket layer may still parse what we could not.
    return groups === null ? true : isPrivateIpv6(groups);
  }

  return false;
}

function safeMcpUrl() {
  return z.string().url().superRefine((value, ctx) => {
    if (process.env.CYCGRAPH_ALLOW_PRIVATE_MCP_URLS === 'true') return;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return; // .url() already reported the format error
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `MCP transport URL must use http(s), got "${parsed.protocol}"`,
      });
      return;
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `MCP transport URL host "${parsed.hostname}" is private/loopback/link-local and is blocked (SSRF guard). ` +
          `Set CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true to allow it in development.`,
      });
    }
  });
}

export const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.enum(ALLOWED_STDIO_COMMANDS),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const HTTPTransportSchema = z.object({
  type: z.literal('http'),
  url: safeMcpUrl(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SSETransportSchema = z.object({
  type: z.literal('sse'),
  url: safeMcpUrl(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const MCPTransportConfigSchema = z.discriminatedUnion('type', [
  StdioTransportSchema,
  HTTPTransportSchema,
  SSETransportSchema,
]);

export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;

// ─── MCP Server Entry (Registry Data) ──────────────────────────────

/**
 * A registered MCP server entry.
 *
 * Stored in the trusted MCP Server Registry. Only administrators
 * can create/modify entries. Agent configs reference servers by `id`.
 */
export const MCPServerEntrySchema = z.object({
  /** Unique server identifier (used as map key and in tool namespacing). */
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
  /** Human-readable name. */
  name: z.string(),
  /** Optional description of what this server provides. */
  description: z.string().optional(),
  /** Transport configuration (stdio, HTTP, or SSE). */
  transport: MCPTransportConfigSchema,
  /** Agent IDs allowed to use this server. Omit or `undefined` for unrestricted access. */
  allowed_agents: z.array(z.string()).optional(),
  /** Connection timeout in milliseconds. */
  timeout_ms: z.number().int().positive().max(3_600_000).default(30_000),
  /** Per-tool execution timeout in milliseconds. Applied to each tool call. */
  tool_timeout_ms: z.number().int().positive().max(3_600_000).optional(),
  /**
   * Max concurrent tool calls in flight against this server. Bounds fan-out
   * (e.g. evolution/voting/map candidates all calling the same server) so one
   * server isn't overwhelmed. Omit for unlimited (or use the manager-level
   * `default_max_concurrent_calls`).
   */
  max_concurrent_calls: z.number().int().positive().optional(),
  /** Maximum connection retries before giving up. @default 2 */
  max_retries: z.number().int().min(0).max(10).optional(),
}).superRefine((entry, ctx) => {
  // Hosted lockdown: reject stdio transports at the trust boundary (every
  // registry read/write parses this), so a tenant cannot persist a server that
  // would spawn a process on a shared worker. Connection-time enforcement in
  // the connection manager is the defense-in-depth backstop.
  if (entry.transport.type === 'stdio' && isStdioMcpDisabled()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transport', 'type'],
      message: 'stdio MCP transports are disabled in this deployment (MCP_STDIO_DISABLED). Use an http or sse transport.',
    });
  }
});

export type MCPServerEntry = z.infer<typeof MCPServerEntrySchema>;

/**
 * camelCase authoring type for MCP server registration (`allowedAgents`,
 * `timeoutMs`, …), derived from the snake_case {@link MCPServerEntry} wire
 * type. Accepted by `saveServer`; stored entries and `loadServer` results
 * remain snake_case. Transport `env` / `headers` keys are preserved verbatim.
 */
export type MCPServerConfig = Camelize<MCPServerEntry>;

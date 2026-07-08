/**
 * Tool Source Types — MCP Server Registry & Agent Tool Declarations
 *
 * Defines the structured tool source system that replaces bare `string[]`
 * tool references in agent configs. Agents declare what tools they need
 * via `ToolSource[]`; the trusted MCP Server Registry holds transport
 * configurations.
 *
 * @module types/tools
 */

import { z } from 'zod';
import type { Camelize } from './case-mapping.js';

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
  /** Filter to specific tools from this server. Omit for all tools. */
  tool_names: z.array(z.string()).optional(),
});

/**
 * Discriminated union of tool source types.
 *
 * Agents declare their tool requirements as `ToolSource[]`.
 * Resolution happens at execution time via MCPConnectionManager.
 */
export const ToolSourceSchema = z.discriminatedUnion('type', [
  BuiltinToolSourceSchema,
  MCPToolSourceSchema,
]);

export type ToolSource = z.infer<typeof ToolSourceSchema>;

/**
 * camelCase authoring type for tool sources (`serverId`, `toolNames`), derived
 * from the snake_case {@link ToolSource} wire type. Used when authoring node /
 * agent `tools`; the constructors remap to snake_case for the engine.
 */
export type ToolSourceConfig = Camelize<ToolSource>;
export type BuiltinToolSource = z.infer<typeof BuiltinToolSourceSchema>;
export type MCPToolSource = z.infer<typeof MCPToolSourceSchema>;

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

/** Extract the embedded IPv4 from an IPv4-mapped IPv6 host (`::ffff:…`), or null. */
function extractMappedIpv4(host: string): string | null {
  const m = host.match(/^::ffff:(.+)$/);
  if (!m) return null;
  const rest = m[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest; // ::ffff:127.0.0.1
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // ::ffff:7f00:1
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  // URL.hostname keeps IPv6 in brackets — strip them.
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv4 in any encoding, including IPv4-mapped IPv6 (dotted or hex form).
  const ipv4Candidate = extractMappedIpv4(host) ?? host;
  const octets = canonicalizeIpv4(ipv4Candidate);
  if (octets) return isPrivateIpv4(octets[0], octets[1], octets[2], octets[3]);

  // IPv6
  if (host === '::1' || host === '::') return true;            // loopback / unspecified
  if (host.startsWith('fe8') || host.startsWith('fe9') ||
      host.startsWith('fea') || host.startsWith('feb')) return true; // link-local fe80::/10
  if (host.startsWith('fc') || host.startsWith('fd')) return true;   // unique-local fc00::/7

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
  timeout_ms: z.number().default(30_000),
  /** Per-tool execution timeout in milliseconds. Applied to each tool call. */
  tool_timeout_ms: z.number().optional(),
  /**
   * Max concurrent tool calls in flight against this server. Bounds fan-out
   * (e.g. evolution/voting/map candidates all calling the same server) so one
   * server isn't overwhelmed. Omit for unlimited (or use the manager-level
   * `default_max_concurrent_calls`).
   */
  max_concurrent_calls: z.number().int().positive().optional(),
  /** Maximum connection retries before giving up. @default 2 */
  max_retries: z.number().optional(),
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

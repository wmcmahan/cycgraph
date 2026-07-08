/**
 * MCP Transport Security
 *
 * The connection-time security guards applied to MCP server transports,
 * isolated here as a focused review surface for security-sensitive code:
 *
 * - **Stdio env scrubbing** — strips code-injection env vars from
 *   registry-supplied `env` maps before spawning an allowlisted binary.
 * - **Connect-time SSRF re-check** — resolves http/sse hosts and rejects
 *   any that resolve to private/loopback/link-local addresses (defeats
 *   static public→private DNS records that slip past the parse-time
 *   schema guard).
 *
 * The parse-time counterparts (stdio command allowlist, literal-hostname
 * SSRF guard) live in `types/tools.ts` on `MCPServerEntrySchema`.
 *
 * @module mcp/transport-security
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateOrLoopbackHost } from '../types/tools.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp.transport-security');

/**
 * Environment variables that turn an allowlisted interpreter/loader into
 * arbitrary code execution at process startup (before any argument is read).
 * The stdio command allowlist (`npx`/`node`/`python*`/`uvx`) constrains only
 * the binary — not what it loads — so registry-supplied `env` is scrubbed of
 * these as defense-in-depth. On a hosted/multi-tenant worker this is the
 * difference between "a registry write" and "cross-tenant RCE".
 */
const DANGEROUS_STDIO_ENV = new Set<string>([
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONINSPECT',
  'PYTHONEXECUTABLE',
  'BROWSER',
]);

/** Env var name prefixes that are blanket-stripped (macOS dynamic loader). */
const DANGEROUS_STDIO_ENV_PREFIXES = ['DYLD_'];

/** Max time to spend resolving an MCP host before failing the connection. */
const DNS_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Connect-time SSRF re-check for http/sse transports. The parse-time schema
 * guard only inspects the literal hostname, so a public name that *resolves*
 * to a private IP (DNS rebinding → cloud metadata / internal services) slips
 * through. Here we resolve the host and reject if ANY returned address is
 * private/loopback/link-local.
 *
 * Honors the same `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS` operator escape hatch as
 * the schema guard. Note (documented limitation): the SDK re-resolves the
 * hostname when it connects, so a fast-flip (TTL-0) rebinding attacker with a
 * narrow window between this lookup and that connect is not fully closed —
 * pair with network egress policy for that residual. This defeats the common
 * case (a static public→private A record) at the app layer.
 */
export async function assertHostResolvesPublic(rawUrl: string, serverId: string): Promise<void> {
  if (process.env.CYCGRAPH_ALLOW_PRIVATE_MCP_URLS === 'true') return;

  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return; // Malformed URL — the transport client will surface the error.
  }
  // Strip IPv6 brackets for dns.lookup (URL.hostname keeps them).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  let addresses: string[];
  try {
    const lookup = dnsLookup(host, { all: true });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`DNS lookup for MCP host "${host}" timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms`)),
        DNS_LOOKUP_TIMEOUT_MS,
      );
      // Don't keep the event loop alive on the timer.
      (t as { unref?: () => void }).unref?.();
    });
    const resolved = await Promise.race([lookup, timeout]);
    addresses = resolved.map((r) => r.address);
  } catch (err) {
    // Resolution failed/timed out — fail closed rather than connect blind.
    throw new Error(
      `MCP server "${serverId}" host "${host}" could not be resolved for SSRF validation: ${(err as Error).message}`,
    );
  }

  const blocked = addresses.filter((addr) => isPrivateOrLoopbackHost(addr));
  if (blocked.length > 0) {
    logger.warn('mcp_ssrf_blocked_resolved_ip', { server_id: serverId, host, blocked });
    throw new Error(
      `MCP server "${serverId}" host "${host}" resolves to a private/loopback address (${blocked.join(', ')}) ` +
        `and is blocked (SSRF guard). Set CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true to allow it in development.`,
    );
  }
}

/**
 * Strip code-injection env vars from a registry-supplied stdio env map.
 * Comparison is case-insensitive (the OS treats env names case-sensitively,
 * but attackers don't get to smuggle `Node_Options`). Returns the cleaned map
 * plus the names dropped, for logging.
 */
export function scrubStdioEnv(
  env: Record<string, string> | undefined,
): { env: Record<string, string>; dropped: string[] } {
  const clean: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    const upper = key.toUpperCase();
    if (
      DANGEROUS_STDIO_ENV.has(upper) ||
      DANGEROUS_STDIO_ENV_PREFIXES.some((p) => upper.startsWith(p))
    ) {
      dropped.push(key);
      continue;
    }
    clean[key] = value;
  }
  return { env: clean, dropped };
}

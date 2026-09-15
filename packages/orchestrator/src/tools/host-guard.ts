/**
 * Connect-time SSRF host guard.
 *
 * One implementation of "resolve this host, reject if any address it maps
 * to is private" for every caller that has already judged a literal
 * hostname with {@link isPrivateOrLoopbackHost}: MCP transports, A2A agent
 * card endpoints, and the web tools. The range logic, the lookup budget,
 * and the literal-IP short circuit live here so the copies cannot drift.
 *
 * @module tools/host-guard
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateOrLoopbackHost } from './schema.js';

/** Default ceiling on one lookup before the guard fails closed. */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/** Options for {@link assertResolvedHostPublic}. */
export interface ResolvedHostGuardOptions {
  /**
   * Names the guarded thing in thrown messages, rendered as
   * `${subject} "${host}" …` — e.g. `agent card endpoint host`.
   */
  subject: string;
  /** Operator escape hatch: when true the host is accepted without a lookup. */
  allowPrivate?: boolean;
  /** Sentence appended to the blocked message, naming the caller's opt-out. */
  hint?: string;
  /** Ceiling on the lookup. Defaults to {@link DNS_LOOKUP_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * True for a host that is already an IP literal in any encoding the
 * hostname guard understands (dotted or integer IPv4, bare IPv6). Such a
 * host was fully judged by the caller's literal check, so resolving it
 * would buy nothing and cost a `getaddrinfo`.
 */
function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0 || /^[0-9.]+$/.test(host);
}

/**
 * Reject a hostname whose DNS record points anywhere private: resolve it
 * and throw if ANY returned address is private/loopback/link-local.
 *
 * Callers must have already run {@link isPrivateOrLoopbackHost} on the
 * literal hostname — this is the second half of that protocol, catching
 * the public NAME that resolves to a private ADDRESS (DNS rebinding) that
 * a literal test cannot see. Lookup failure and lookup timeout both fail
 * closed rather than letting the connection proceed blind.
 *
 * Documented residual: the caller's own connect re-resolves the name, so a
 * TTL-0 attacker flipping the record inside that window is not closed
 * here — pair with network egress policy.
 *
 * @param hostname - Host to resolve; IPv6 brackets are tolerated and stripped.
 * @param options - Message subject, opt-out, and budget for this call site.
 * @throws {Error} When the host resolves privately, or cannot be resolved.
 */
export async function assertResolvedHostPublic(
  hostname: string,
  options: ResolvedHostGuardOptions,
): Promise<void> {
  if (options.allowPrivate === true) return;

  // dns.lookup wants a bare host; URL.hostname keeps IPv6 bracketed.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIpLiteral(host)) return;

  const timeoutMs = options.timeoutMs ?? DNS_LOOKUP_TIMEOUT_MS;

  let addresses: string[];
  try {
    // AbortSignal.timeout's timer does not hold the event loop open.
    const timeout = AbortSignal.timeout(timeoutMs);
    const expired = new Promise<never>((_, reject) => {
      timeout.addEventListener(
        'abort',
        () => reject(new Error(`lookup did not complete within the ${timeoutMs}ms budget`)),
        { once: true },
      );
    });
    const resolved = await Promise.race([dnsLookup(host, { all: true }), expired]);
    addresses = resolved.map((entry) => entry.address);
  } catch (error) {
    throw new Error(
      `${options.subject} "${host}" could not be resolved for SSRF validation: ${(error as Error).message}`,
      { cause: error },
    );
  }

  const blocked = addresses.filter((address) => isPrivateOrLoopbackHost(address));
  if (blocked.length > 0) {
    throw new Error(
      `${options.subject} "${host}" resolves to a private/loopback address (${blocked.join(', ')}) `
      + `and is blocked (SSRF guard).${options.hint === undefined ? '' : ` ${options.hint}`}`,
    );
  }
}

/**
 * Connect-time SSRF host guard.
 *
 * One implementation of "resolve this host, reject if any address it maps
 * to is private" for every caller that also judges the literal hostname
 * with {@link isPrivateOrLoopbackHost}: MCP transports, A2A agent card
 * endpoints, and the web tools. The range logic, the lookup budget, and the
 * literal-IP handling live here so the copies cannot drift.
 *
 * @module tools/host-guard
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateOrLoopbackHost } from './schema.js';

/** Default ceiling on one lookup before the guard fails closed. */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Thrown when a host's DNS record points at a private target. Carries the
 * offending addresses so a call site can log the block decision with the
 * addresses that caused it, distinct from a lookup that never answered.
 */
export class ResolvedHostBlockedError extends Error {
  /** Every resolved address that failed the private-range test. */
  readonly blocked: string[];

  constructor(message: string, blocked: string[]) {
    super(message);
    this.name = 'ResolvedHostBlockedError';
    this.blocked = blocked;
  }
}

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
 * host has no DNS record to consult, so it is range-checked here instead
 * of resolved.
 */
function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0 || /^[0-9.]+$/.test(host) || host.includes(':');
}

/**
 * Reject a hostname whose DNS record points anywhere private: resolve it
 * and throw if ANY returned address is private/loopback/link-local.
 *
 * This is the second half of the guard protocol, catching the public NAME
 * that resolves to a private ADDRESS (DNS rebinding) that a literal test
 * cannot see. An IP literal has no record to consult, so it is range-checked
 * here rather than resolved — the stage re-judges it instead of trusting
 * that the caller's literal test ran. Lookup failure and lookup timeout both
 * fail closed rather than letting the connection proceed blind.
 *
 * Documented residual: the caller's own connect re-resolves the name, so a
 * TTL-0 attacker flipping the record inside that window is not closed
 * here — pair with network egress policy.
 *
 * @param hostname - Host to resolve; IPv6 brackets are tolerated and stripped.
 * @param options - Message subject, opt-out, and budget for this call site.
 * @throws {ResolvedHostBlockedError} When the host is a private literal or
 * any resolved address is private.
 * @throws {Error} When the host cannot be resolved within the budget.
 */
export async function assertResolvedHostPublic(
  hostname: string,
  options: ResolvedHostGuardOptions,
): Promise<void> {
  if (options.allowPrivate === true) return;

  // dns.lookup wants a bare host; URL.hostname keeps IPv6 bracketed.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIpLiteral(host)) {
    if (!isPrivateOrLoopbackHost(host)) return;
    throw new ResolvedHostBlockedError(
      `${options.subject} "${host}" is a private/loopback address literal and is blocked (SSRF guard).`
      + `${options.hint === undefined ? '' : ` ${options.hint}`}`,
      [host],
    );
  }

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
    throw new ResolvedHostBlockedError(
      `${options.subject} "${host}" resolves to a private/loopback address (${blocked.join(', ')}) `
      + `and is blocked (SSRF guard).${options.hint === undefined ? '' : ` ${options.hint}`}`,
      blocked,
    );
  }
}

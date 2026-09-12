/**
 * Connect-time DNS re-check shared by every protocol that accepts a
 * remote-supplied URL.
 *
 * A literal-hostname guard only sees the string a peer advertised: a
 * public-looking name whose record points at `127.0.0.1`,
 * `169.254.169.254`, or an RFC1918 address passes it, and the transport
 * then resolves that name and connects to the private address (DNS
 * rebinding). Resolving here — against the same range/encoding logic as
 * {@link isPrivateOrLoopbackHost} — closes the static case for all of
 * them from one place.
 *
 * @module security/dns-rebinding
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateOrLoopbackHost } from '../tools/schema.js';

/** Default budget for one lookup before the guard fails closed. */
export const DNS_LOOKUP_TIMEOUT_MS = 5000;

/** Options for {@link assertResolvedHostPublic}. */
export interface ResolvedHostGuardOptions {
  /**
   * Operator escape hatch: the re-check is skipped when this environment
   * variable is `'true'`. Pass the same name the caller's literal-host
   * guard honors — one protocol, one decision.
   */
  allowEnvVar: string;
  /**
   * Phrase every message opens with, naming what is being checked —
   * e.g. `MCP server "docs"` or `agent card endpoint "https://a/rpc"`.
   */
  subject: string;
  /** Lookup budget in ms. Defaults to {@link DNS_LOOKUP_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Assert `hostname` does not resolve to a private/loopback/link-local
 * address. IPv6 brackets are stripped, and a literal IP resolves to
 * itself so it is skipped — callers must decide literals with
 * {@link isPrivateOrLoopbackHost} before calling this.
 *
 * Fails closed: a lookup that errors or outruns its budget throws rather
 * than letting the transport connect unvalidated. A TTL-0 attacker who
 * flips the record between this lookup and the transport's own connect is
 * a documented residual — pair with network egress policy for that.
 *
 * @param hostname - Host to resolve, bracketed or bare.
 * @param options - Env-var opt-out, message subject, and lookup budget.
 * @throws {Error} When resolution fails, outruns the budget, or returns
 * any private address.
 */
export async function assertResolvedHostPublic(
  hostname: string,
  options: ResolvedHostGuardOptions,
): Promise<void> {
  const { allowEnvVar, subject, timeoutMs = DNS_LOOKUP_TIMEOUT_MS } = options;
  if (process.env[allowEnvVar] === 'true') return;

  // URL.hostname keeps IPv6 in brackets; dns.lookup wants the bare address.
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return;

  let addresses: Array<{ address: string }>;
  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`lookup timed out after ${timeoutMs}ms`)),
        timeoutMs);
      // A pending guard must not hold the process open.
      (timer as { unref?: () => void }).unref?.();
    });
    addresses = await Promise.race([dnsLookup(host, { all: true, verbatim: true }), timeout]);
  } catch (error) {
    throw new Error(
      `${subject} host "${host}" could not be resolved for SSRF validation: `
      + `${(error as Error).message}`,
      { cause: error });
  }

  const blocked = addresses.filter((entry) => isPrivateOrLoopbackHost(entry.address));
  if (blocked.length > 0) {
    throw new Error(
      `${subject} host "${host}" resolves to a private/loopback address `
      + `(${blocked.map((entry) => entry.address).join(', ')}) and is blocked (SSRF guard). `
      + `Set ${allowEnvVar}=true to allow it in development.`);
  }
}

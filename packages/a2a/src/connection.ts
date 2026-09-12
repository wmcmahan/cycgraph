/**
 * SDK client construction.
 *
 * A client is built per call because auth and trace headers are resolved
 * per call; caching one would freeze the first caller's headers into every
 * later request. The Agent Card is cached per URL AND header set, fetched
 * with the same per-server headers as every other request (a registry
 * entry's auth gate covers its card endpoint too), and a resolution that
 * fails or outruns its own timeout is evicted so a transient fault never
 * outlives the request that hit it.
 *
 * @module connection
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import type { Client as SdkClient } from '@a2a-js/sdk/client';
import { isPrivateOrLoopbackHost } from '@cycgraph/orchestrator';
import { raceAbort } from './race.js';

/**
 * Builds the SDK client one call runs against. Injectable for tests.
 * The optional `signal` bounds every request THIS client issues — it is
 * merged into the SDK transport's fetches so a stalled remote aborts at
 * the caller's deadline instead of holding the socket open forever.
 */
export type CreateSdkClient = (
  agentCardUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<SdkClient>;

/**
 * Trace-context headers, excluded from the card cache key: they change on
 * every call and identify our trace, not the caller's credentials, so
 * including them would reduce the cache to one fetch per request.
 */
const TRACE_HEADERS = new Set(['traceparent', 'tracestate', 'baggage']);

/**
 * Cache key for one Agent Card resolution.
 *
 * The URL alone is not the identity of a card fetch: two registry entries
 * may share one `agent_card_url` and differ in `auth`, so a card resolved
 * with one entry's credentials must never be served to the other. Header
 * names are lowercased and sorted so an equivalent header set yields one
 * key, and the key is a JSON array so a header value containing the
 * delimiter cannot forge another entry's key.
 */
function cardKey(agentCardUrl: string, headers: Record<string, string>): string {
  const identifying = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => !TRACE_HEADERS.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([agentCardUrl, identifying]);
}

/** Every endpoint URL a resolved card offers, across proto and legacy shapes. */
function endpointUrls(card: unknown): string[] {
  const record = card as { url?: unknown; supportedInterfaces?: unknown; additionalInterfaces?: unknown };
  const urls: unknown[] = [record.url];
  for (const list of [record.supportedInterfaces, record.additionalInterfaces]) {
    if (Array.isArray(list)) for (const entry of list) urls.push((entry as { url?: unknown } | null)?.url);
  }
  return urls.filter((value): value is string => typeof value === 'string' && value !== '');
}

/** Max time spent resolving one endpoint host before the guard fails closed. */
const DNS_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Connect-time DNS re-check for one card endpoint host. The literal-hostname
 * test above only sees the string the remote advertised: a public-looking
 * name whose record points at `127.0.0.1`, `169.254.169.254`, or an RFC1918
 * address passes it, and the SDK's own `fetch` then resolves that name and
 * connects to the private address (DNS rebinding). Resolving here and
 * rejecting if ANY returned address is private closes the static case.
 *
 * Fails closed: a lookup that errors or outruns its budget blocks the
 * endpoint rather than letting the transport connect unvalidated. A TTL-0
 * attacker who flips the record between this lookup and the SDK's connect
 * is a documented residual — pair with network egress policy for that.
 */
async function assertEndpointResolvesPublic(parsed: URL, value: string): Promise<void> {
  // URL.hostname keeps IPv6 in brackets; dns.lookup wants the bare address.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  // Literal IPs were fully decided by isPrivateOrLoopbackHost — nothing to resolve.
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return;

  let addresses: Array<{ address: string }>;
  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms`)),
        DNS_LOOKUP_TIMEOUT_MS);
      // A pending guard must not hold the process open.
      (timer as { unref?: () => void }).unref?.();
    });
    addresses = await Promise.race([dnsLookup(host, { all: true, verbatim: true }), timeout]);
  } catch (error) {
    throw new Error(
      `agent card endpoint "${value}" host "${host}" could not be resolved for SSRF validation: `
      + `${(error as Error).message}`,
      { cause: error });
  }

  const blocked = addresses.filter((entry) => isPrivateOrLoopbackHost(entry.address));
  if (blocked.length > 0) {
    throw new Error(
      `agent card endpoint "${value}" resolves to a private/loopback address `
      + `(${blocked.map((entry) => entry.address).join(', ')}) and is blocked (SSRF guard). `
      + 'Set CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true to allow it in development.');
  }
}

/**
 * SSRF guard over the endpoints a resolved Agent Card offers. The
 * registry validates the CARD url before any request leaves, but the
 * card's returned RPC endpoints come from the remote — a compromised
 * agent could point the transport at loopback or cloud-metadata hosts.
 * Each endpoint is checked as a literal host AND re-checked against its
 * DNS-resolved addresses, so a public name pointing at a private address
 * is refused too. Honors the card-url guard's opt-out: one protocol, one
 * decision.
 */
async function assertPublicEndpoints(card: unknown): Promise<void> {
  if (process.env['CYCGRAPH_ALLOW_PRIVATE_A2A_URLS'] === 'true') return;
  for (const value of endpointUrls(card)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`agent card offers an unparseable endpoint URL "${value}" (SSRF guard)`);
    }
    // Scheme first, as the card-url and MCP guards do: a non-http(s)
    // URL (file:, gopher:) can carry an empty hostname the host test
    // would wave through.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`agent card endpoint "${value}" must use http(s), got "${parsed.protocol}" (SSRF guard)`);
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new Error(
        `agent card endpoint "${value}" points at a private/loopback host and is blocked (SSRF guard). `
        + 'Set CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true to allow it in development.');
    }
    await assertEndpointResolvesPublic(parsed, value);
  }
}

/**
 * The fetch every request of one call goes through: `headers` are applied
 * over whatever the SDK set, and `signal`, when given, bounds the request.
 *
 * A delivery bound is COMBINED with the SDK's own `init.signal` rather
 * than replacing it, so neither the SDK's per-request cancellation nor
 * the caller's deadline can be lost. Omitting `signal` leaves the SDK's
 * own signal, if any, exactly as it came.
 */
export function requestFetch(headers: Record<string, string>, signal?: AbortSignal): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
      ...(signal !== undefined
        ? { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }
        : {}),
    });
}

/**
 * Ceiling on one shared Agent Card resolution, independent of any single
 * caller's deadline.
 */
const CARD_TIMEOUT_MS = 30_000;

/** Options for {@link sdkClientFactory}. */
export interface SdkClientFactoryOptions {
  /** Ceiling on one shared card resolution. Defaults to 30s. */
  cardTimeoutMs?: number;
}

/**
 * Default {@link CreateSdkClient}, with an Agent Card cache scoped to this
 * factory and keyed by URL plus the headers the card was fetched with.
 */
export function sdkClientFactory(options: SdkClientFactoryOptions = {}): CreateSdkClient {
  const cardTimeoutMs = options.cardTimeoutMs ?? CARD_TIMEOUT_MS;
  const cards = new Map<string, Promise<unknown>>();

  return async (agentCardUrl, headers, signal) => {
    const fetchImpl = requestFetch(headers, signal);

    const key = cardKey(agentCardUrl, headers);
    let card = cards.get(key);
    if (!card) {
      // The promise is cached, so concurrent first calls share one fetch.
      // It carries the caller's headers but not its signal: a shared
      // promise must not be rejected for everyone by one caller's abort.
      // deliver() still bounds the caller itself against its own signal.
      //
      // Its own timeout replaces that missing signal: a remote that
      // accepts the connection and never answers would otherwise leave a
      // pending promise cached at this key for the life of the process.
      const cardTimeout = AbortSignal.timeout(cardTimeoutMs);
      const cardFetch = requestFetch(headers, cardTimeout);
      // The race is what guarantees the promise settles even if the fetch
      // ignores its abort, and settling is what evicts the cache entry.
      const resolving = raceAbort(
        new DefaultAgentCardResolver({ fetchImpl: cardFetch }).resolve(agentCardUrl, ''),
        cardTimeout,
        () => new Error(
          `agent card resolution did not complete within the ${cardTimeoutMs}ms budget`,
          { cause: cardTimeout.reason }),
      );
      cards.set(key, resolving);
      resolving.catch(() => {
        if (cards.get(key) === resolving) cards.delete(key);
      });
      card = resolving;
    }

    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    });
    const resolved = await card;
    // Checked per call, not per resolution: the card is cached, and the
    // guard must hold for cached reuse too.
    await assertPublicEndpoints(resolved);
    // Cast: the resolver returns parsed JSON; the factory validates it.
    return factory.createFromAgentCard(resolved as never);
  };
}

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

import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import type { Client as SdkClient } from '@a2a-js/sdk/client';
import { assertResolvedHostPublic, isPrivateOrLoopbackHost } from '@cycgraph/orchestrator';
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

/** Operator opt-out shared by both A2A guards: one protocol, one decision. */
function allowsPrivateUrls(): boolean {
  return process.env['CYCGRAPH_ALLOW_PRIVATE_A2A_URLS'] === 'true';
}

/** Sentence naming the opt-out, appended to every refusal both guards raise. */
const OPT_OUT_HINT = 'Set CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true to allow it in development.';

/**
 * SSRF guard over the Agent Card URL itself, run before the card request
 * leaves. Returns the hostname it cleared, so the endpoint guard does not
 * resolve the same host a second time in one call.
 *
 * The registry judges this URL's literal hostname when an entry is
 * written and when it is read, but the card fetch resolves the name again
 * when it connects: a host that resolved publicly at registry-write time
 * and privately at call time (DNS rebinding, or an A record simply
 * changed since) would otherwise reach internal infrastructure or the
 * cloud metadata endpoint. The literal test is repeated here because this
 * factory is also reachable without the registry, and because the
 * resolved-host guard short-circuits IP literals on the premise that its
 * caller already judged them.
 */
async function assertPublicCardUrl(agentCardUrl: string): Promise<Set<string>> {
  if (allowsPrivateUrls()) return new Set();
  let parsed: URL;
  try {
    parsed = new URL(agentCardUrl);
  } catch {
    // Unparseable: the card resolver's own failure is the clearer error.
    return new Set();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`agent card url "${agentCardUrl}" must use http(s), got "${parsed.protocol}" (SSRF guard)`);
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error(
      `agent card url "${agentCardUrl}" points at a private/loopback host and is blocked (SSRF guard). `
      + OPT_OUT_HINT);
  }
  await assertResolvedHostPublic(parsed.hostname, {
    subject: 'agent card url host',
    hint: OPT_OUT_HINT,
  });
  return new Set([parsed.hostname]);
}

/**
 * SSRF guard over the endpoints a resolved Agent Card offers. The
 * registry validates the CARD url before any request leaves, but the
 * card's returned RPC endpoints come from the remote — a compromised
 * agent could point the transport at loopback or cloud-metadata hosts.
 * Honors the card-url guard's opt-out: one protocol, one decision.
 *
 * Each endpoint is judged twice: on its literal hostname, then on the
 * addresses that hostname actually resolves to. The literal test alone
 * cannot see a public name whose DNS record points at a private IP, and
 * the transport's own fetch resolves the name again when it connects —
 * so a card advertising `attacker.example` would otherwise reach
 * 169.254.169.254 unchallenged. `cleared` names hosts already resolved
 * by {@link assertPublicCardUrl} in this same call.
 */
async function assertPublicEndpoints(card: unknown, cleared: ReadonlySet<string>): Promise<void> {
  if (allowsPrivateUrls()) return;
  const hosts = new Set<string>();
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
        + OPT_OUT_HINT);
    }
    hosts.add(parsed.hostname);
  }
  // Every literal host cleared before any lookup runs, so a card that is
  // already refusable costs no DNS traffic.
  for (const host of hosts) {
    if (cleared.has(host)) continue;
    await assertResolvedHostPublic(host, {
      subject: 'agent card endpoint host',
      hint: OPT_OUT_HINT,
    });
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
    // Before the cache lookup, so a cache miss never fetches a card from
    // a host this call has not cleared, and a cache hit is still judged
    // against what the name resolves to now.
    const cleared = await assertPublicCardUrl(agentCardUrl);

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
    await assertPublicEndpoints(resolved, cleared);
    // Cast: the resolver returns parsed JSON; the factory validates it.
    return factory.createFromAgentCard(resolved as never);
  };
}

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
 *
 * `allowedEndpointHosts` widens the set of hosts the resolved Agent Card
 * may name as an RPC endpoint; `agentCardUrl`'s own host is always
 * accepted. Anything else is refused, because `headers` carry the
 * server's credential to whichever endpoint the card names.
 */
export type CreateSdkClient = (
  agentCardUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  allowedEndpointHosts?: readonly string[],
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
 * One host in the form the pin compares: lowercased, IPv6 brackets
 * stripped, so a configured host and a `URL.hostname` of the same host
 * are the same string.
 */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/**
 * The hosts a card's endpoints may name: the host of the trusted card
 * URL, plus whatever the registry entry allowlisted. An unparseable card
 * URL contributes nothing — the card resolver's own failure reports it.
 */
function pinnedHosts(agentCardUrl: string, allowedEndpointHosts: readonly string[]): Set<string> {
  const hosts = new Set(allowedEndpointHosts.map(normalizeHost));
  try {
    hosts.add(normalizeHost(new URL(agentCardUrl).hostname));
  } catch {
    // Unparseable: nothing to pin to, so every endpoint is refused.
  }
  return hosts;
}

/**
 * SSRF guard over the endpoints a resolved Agent Card offers. The
 * registry validates the CARD url before any request leaves, but the
 * card's returned RPC endpoints come from the remote — a compromised
 * agent could point the transport at loopback or cloud-metadata hosts,
 * or at a public host of its own choosing.
 *
 * Each endpoint is pinned to `pinned` — the card URL's own host plus any
 * the caller allowlisted. Every request built from the card carries this server's
 * resolved credential, so an endpoint on an unrelated host — public and
 * DNS-clean though it may be — is a credential-exfiltration channel, not
 * merely an SSRF one. The pin therefore holds even under the private-URL
 * opt-out, which speaks only to internal addresses: a host the operator
 * genuinely serves the RPC endpoint from belongs in the allowlist.
 *
 * Each endpoint is then judged twice on privacy: on its literal
 * hostname, then on the addresses that hostname actually resolves to.
 * The literal test alone cannot see a public name whose DNS record
 * points at a private IP, and the transport's own fetch resolves the
 * name again when it connects — so a pinned host whose record flips to
 * 169.254.169.254 would otherwise be reached unchallenged. `cleared`
 * names hosts already resolved by {@link assertPublicCardUrl} in this
 * same call.
 */
async function assertPublicEndpoints(
  card: unknown,
  cleared: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): Promise<void> {
  const skipPrivateChecks = allowsPrivateUrls();
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
    if (!skipPrivateChecks && isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new Error(
        `agent card endpoint "${value}" points at a private/loopback host and is blocked (SSRF guard). `
        + OPT_OUT_HINT);
    }
    if (!pinned.has(normalizeHost(parsed.hostname))) {
      throw new Error(
        `agent card endpoint "${value}" is on host "${parsed.hostname}", which is neither the agent card url's `
        + `host nor an allowed endpoint host for this server; requests to it would carry this server's `
        + `credentials (SSRF guard).`);
    }
    if (skipPrivateChecks) continue;
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
 * SSRF guard over a redirect target, run before the next hop leaves.
 *
 * The card-url and endpoint guards judge URLs THIS package chose to
 * request; a 3xx `location` is chosen by the remote, so it is judged on
 * the same terms — scheme, pinned host, literal host, then resolved
 * addresses.
 *
 * The host pin is the same `pinned` set the endpoint guard applies, and
 * for the same reason: the replayed hop carries this server's credential
 * in its headers, so a remote that can no longer NAME an unrelated host
 * in its card would otherwise reach it by answering with `Location:`
 * instead. It therefore holds even under the private-URL opt-out, which
 * speaks only to internal addresses; the privacy checks below honor that
 * opt-out, one protocol, one decision.
 */
async function assertPublicRedirect(target: URL, pinned: ReadonlySet<string>): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(
      `request redirected to "${target.href}", which must use http(s), got "${target.protocol}" (SSRF guard)`);
  }
  if (!pinned.has(normalizeHost(target.hostname))) {
    throw new Error(
      `request redirected to "${target.href}", whose host "${target.hostname}" is neither the agent card url's `
      + `host nor an allowed endpoint host for this server; the redirected request would carry this server's `
      + `credentials (SSRF guard).`);
  }
  if (allowsPrivateUrls()) return;
  if (isPrivateOrLoopbackHost(target.hostname)) {
    throw new Error(
      `request redirected to "${target.href}", a private/loopback host, and is blocked (SSRF guard). `
      + OPT_OUT_HINT);
  }
  await assertResolvedHostPublic(target.hostname, {
    subject: 'redirect target host',
    hint: OPT_OUT_HINT,
  });
}

/** Maximum redirect hops one request follows, matching the web tools' guard. */
const MAX_REDIRECTS = 5;

/** The URL a fetch call targets, whichever input shape the caller used. */
function targetUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * Init for a redirect hop. A `Request` input carries the method and body
 * that `init` does not, and its URL cannot be swapped for the hop's, so
 * both are lifted out of a clone taken before the first hop consumed it;
 * the body is buffered because a stream cannot be sent twice.
 */
async function replayInit(source: Request | undefined, hopInit: RequestInit): Promise<RequestInit> {
  if (source === undefined) return hopInit;
  return {
    ...hopInit,
    method: source.method,
    ...(source.body !== null ? { body: await source.arrayBuffer() } : {}),
  };
}

/**
 * The fetch every request of one call goes through: `headers` are applied
 * over whatever the SDK set, `signal`, when given, bounds the request, and
 * redirects are followed manually so every hop is SSRF-checked and pinned
 * to `pinned` — the card URL's host plus the caller's allowlisted endpoint
 * hosts, the same set the endpoint guard enforces.
 *
 * A delivery bound is COMBINED with the SDK's own `init.signal` rather
 * than replacing it, so neither the SDK's per-request cancellation nor
 * the caller's deadline can be lost. Omitting `signal` leaves the SDK's
 * own signal, if any, exactly as it came.
 *
 * `redirect: 'follow'` would let a public, DNS-clean host 302 the request
 * — `headers`, bearer token and all — into internal infrastructure
 * unchecked, since the card-url and endpoint guards only ever see the URL
 * this package chose. The first hop is not re-judged here: it is either
 * the card URL {@link assertPublicCardUrl} just cleared or an endpoint
 * {@link assertPublicEndpoints} cleared, and repeating the lookup would
 * cost a DNS round trip per request.
 */
export function requestFetch(
  headers: Record<string, string>,
  pinned: ReadonlySet<string>,
  signal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const hopInit: RequestInit = {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
      ...(signal !== undefined
        ? { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }
        : {}),
      redirect: 'manual',
    };
    const source = typeof input === 'string' || input instanceof URL ? undefined : input.clone();

    let response = await fetch(input, hopInit);
    let current: URL | undefined;
    let replay: RequestInit | undefined;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      await response.body?.cancel();
      current = new URL(location, current ?? targetUrl(input));
      await assertPublicRedirect(current, pinned);
      replay ??= await replayInit(source, hopInit);
      response = await fetch(current, replay);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `request to "${targetUrl(input)}" exceeded ${MAX_REDIRECTS} redirects (SSRF guard)`);
    }
    return response;
  };
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

  return async (agentCardUrl, headers, signal, allowedEndpointHosts) => {
    // This call's own SSRF clearance, started but NOT awaited here: a
    // cache hit is still judged against what the name resolves to now,
    // and awaiting before the cache is consulted would let two
    // concurrent first calls both miss and both fetch the card.
    const clearing = assertPublicCardUrl(agentCardUrl);

    // One set for this call's card endpoints AND for every redirect hop
    // its requests follow: both carry `headers`, so both are pinned the
    // same way.
    const pinned = pinnedHosts(agentCardUrl, allowedEndpointHosts ?? []);

    // Claimed synchronously — no await may separate this lookup from the
    // set below, or the dedup it exists for does not hold.
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
      // The claiming call's pin travels with the shared card fetch, as its
      // headers already do: the cache key holds the credential constant,
      // so every sharer's hop carries the same token to the same hosts.
      const cardFetch = requestFetch(headers, pinned, cardTimeout);
      // Chained on this call's clearance, so no card request leaves for
      // a host the claiming call has not cleared; the race guarantees
      // the promise settles even if the fetch ignores its abort, and
      // settling is what evicts the cache entry.
      const resolving = raceAbort(
        () => clearing.then(() =>
          new DefaultAgentCardResolver({ fetchImpl: cardFetch }).resolve(agentCardUrl, '')),
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

    const fetchImpl = requestFetch(headers, pinned, signal);
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    });
    const cleared = await clearing;
    const resolved = await card;
    // Checked per call, not per resolution: the card is cached, and the
    // guard must hold for cached reuse too.
    await assertPublicEndpoints(resolved, cleared, pinned);
    // Cast: the resolver returns parsed JSON; the factory validates it.
    return factory.createFromAgentCard(resolved as never);
  };
}

/**
 * SDK client construction.
 *
 * A client is built per call because auth and trace headers are resolved
 * per call; caching one would freeze the first caller's headers into every
 * later request. The Agent Card is cached per URL AND header set, fetched
 * with the same per-server headers as every other request (a registry
 * entry's auth gate covers its card endpoint too), and a failed resolution
 * is evicted so a transient fault never outlives the request that hit it.
 *
 * @module connection
 */

import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import type { Client as SdkClient } from '@a2a-js/sdk/client';

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

/**
 * Default {@link CreateSdkClient}, with an Agent Card cache scoped to this
 * factory and keyed by URL plus the headers the card was fetched with.
 */
export function sdkClientFactory(): CreateSdkClient {
  const cards = new Map<string, Promise<unknown>>();

  return async (agentCardUrl, headers, signal) => {
    const fetchImpl: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), ...headers },
        // Combine rather than replace: the SDK may carry its own signal.
        ...(signal !== undefined
          ? { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }
          : {}),
      });

    const key = cardKey(agentCardUrl, headers);
    let card = cards.get(key);
    if (!card) {
      // The promise is cached, so concurrent first calls share one fetch.
      // It carries the caller's headers but not its signal: a shared
      // promise must not be rejected for everyone by one caller's abort.
      // deliver() still bounds the caller itself via raceAbort.
      const cardFetch: typeof fetch = (input, init) =>
        fetch(input, {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), ...headers },
        });
      const resolving = new DefaultAgentCardResolver({ fetchImpl: cardFetch })
        .resolve(agentCardUrl, '');
      cards.set(key, resolving);
      resolving.catch(() => {
        if (cards.get(key) === resolving) cards.delete(key);
      });
      card = resolving;
    }

    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    });
    // Cast: the resolver returns parsed JSON; the factory validates it.
    return factory.createFromAgentCard((await card) as never);
  };
}

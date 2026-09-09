/**
 * SDK client construction.
 *
 * A client is built per call because auth and trace headers are resolved
 * per call; caching one would freeze the first caller's headers into every
 * later request. The Agent Card is cached per URL, fetched with the same
 * per-server headers as every other request (a registry entry's auth gate
 * covers its card endpoint too), and a failed resolution is evicted so a
 * transient fault never outlives the request that hit it.
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

/** Default {@link CreateSdkClient}, with a per-URL Agent Card cache scoped to this factory. */
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

    let card = cards.get(agentCardUrl);
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
      cards.set(agentCardUrl, resolving);
      resolving.catch(() => {
        if (cards.get(agentCardUrl) === resolving) cards.delete(agentCardUrl);
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

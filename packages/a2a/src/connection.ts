/**
 * SDK client construction.
 *
 * A client is built per call because auth and trace headers are resolved
 * per call; caching one would freeze the first caller's headers into every
 * later request. The Agent Card is cached per URL: it is stable public
 * metadata, resolved without per-call headers.
 *
 * @module connection
 */

import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import type { Client as SdkClient } from '@a2a-js/sdk/client';

/** Builds the SDK client one call runs against. Injectable for tests. */
export type CreateSdkClient = (
  agentCardUrl: string,
  headers: Record<string, string>,
) => Promise<SdkClient>;

/** Default {@link CreateSdkClient}, with a per-URL Agent Card cache scoped to this factory. */
export function sdkClientFactory(): CreateSdkClient {
  const cards = new Map<string, Promise<unknown>>();

  return async (agentCardUrl, headers) => {
    const fetchImpl: typeof fetch = (input, init) =>
      fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } });

    let card = cards.get(agentCardUrl);
    if (!card) {
      // The promise is cached, so concurrent first calls share one fetch.
      card = new DefaultAgentCardResolver().resolve(agentCardUrl, '');
      cards.set(agentCardUrl, card);
    }

    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    });
    // Cast: the resolver returns parsed JSON; the factory validates it.
    return factory.createFromAgentCard((await card) as never);
  };
}

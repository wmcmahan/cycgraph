/**
 * SDK client connection
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

/**
 * Create a function that builds the SDK client one call runs against. Injectable for tests.
 */
export function sdkClientFactory(): CreateSdkClient {
  const cards = new Map<string, Promise<unknown>>();

  return async (agentCardUrl, headers) => {
    const fetchImpl: typeof fetch = (input, init) =>
      fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } });

    let card = cards.get(agentCardUrl);

    if (!card) {
      card = new DefaultAgentCardResolver().resolve(agentCardUrl, '');
      cards.set(agentCardUrl, card);
    }

    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    });
    return factory.createFromAgentCard((await card) as never);
  };
}

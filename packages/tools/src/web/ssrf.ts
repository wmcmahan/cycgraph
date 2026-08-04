/**
 * SSRF guard for the web tools.
 *
 * Reuses the orchestrator's `isPrivateOrLoopbackHost` (the same range logic
 * that guards MCP transport URLs, including non-dotted-quad IPv4 encodings
 * and IPv4-mapped IPv6) and adds the DNS re-check: a public-looking name
 * must not resolve to a private address at request time (DNS rebinding).
 *
 * Every redirect hop is re-validated by the caller, so a public host
 * cannot bounce a request into internal infrastructure via a 302.
 *
 * @module web/ssrf
 */

import { lookup } from 'node:dns/promises';
import { isPrivateOrLoopbackHost } from '@cycgraph/orchestrator';

/** Thrown when a URL fails the SSRF policy. Surfaces to the LLM as a tool failure. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Assert a URL is safe for a server-side request: http(s) scheme, a host
 * that is not private/loopback/link-local as a literal, and — for hostnames —
 * no resolved address in a private range either.
 *
 * @param url - The parsed target URL.
 * @param allowPrivateHosts - Operator escape hatch for local development.
 * @throws {SsrfBlockedError} When the URL violates the policy.
 */
export async function assertUrlPublic(url: URL, allowPrivateHosts = false): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`URL scheme "${url.protocol}" is not allowed; use http(s)`);
  }
  if (allowPrivateHosts) return;

  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw new SsrfBlockedError(
      `Host "${url.hostname}" is private/loopback/link-local and is blocked (SSRF guard)`,
    );
  }

  // Literal IPs were fully validated above; only hostnames need the DNS check.
  const bareHost = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[0-9.]+$/.test(bareHost) || bareHost.includes(':')) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bareHost, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfBlockedError(
      `Host "${url.hostname}" could not be resolved for SSRF validation: ${(err as Error).message}`,
    );
  }

  const blocked = addresses.filter((a) => isPrivateOrLoopbackHost(a.address));
  if (blocked.length > 0) {
    throw new SsrfBlockedError(
      `Host "${url.hostname}" resolves to a private address (${blocked[0].address}) and is blocked (SSRF guard)`,
    );
  }
}

/** Maximum redirect hops a guarded fetch will follow. */
export const MAX_REDIRECTS = 5;

/**
 * Fetch with per-hop SSRF validation. Redirects are followed manually so
 * every hop — not just the first URL — passes {@link assertUrlPublic};
 * `redirect: 'follow'` would let a public host 302 into internal
 * infrastructure unchecked.
 */
export async function guardedFetch(
  initialUrl: string,
  init: RequestInit,
  allowPrivateHosts = false,
): Promise<{ response: Response; finalUrl: string }> {
  let current = new URL(initialUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertUrlPublic(current, allowPrivateHosts);
    const response = await fetch(current, { ...init, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: current.href };
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }

    return { response, finalUrl: current.href };
  }

  throw new SsrfBlockedError(`Exceeded ${MAX_REDIRECTS} redirects fetching ${initialUrl}`);
}

/**
 * Read a response body as text, capped at `maxBytes`. Reads the stream
 * incrementally and cancels once the cap is exceeded, so an adversarial
 * multi-gigabyte body never lands in worker memory.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { body: '', truncated: false };

  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (received - maxBytes)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(Math.min(received, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(merged), truncated };
}

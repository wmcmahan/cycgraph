/**
 * TenantResolver / API-key primitive tests.
 *
 * Pure (no database) — runs everywhere.
 */

import { describe, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  hashApiKey,
  generateApiKey,
  InMemoryTenantResolver,
} from '../src/tenant-resolver.js';

describe('hashApiKey', () => {
  test('is deterministic and hex-encoded sha256', () => {
    const h = hashApiKey('cyc_sk_abc');
    expect(h).toBe(hashApiKey('cyc_sk_abc'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different keys hash differently', () => {
    expect(hashApiKey('a')).not.toBe(hashApiKey('b'));
  });
});

describe('generateApiKey', () => {
  test('mints a prefixed key whose hash matches hashApiKey', () => {
    const { rawKey, hash } = generateApiKey();
    expect(rawKey.startsWith('cyc_sk_')).toBe(true);
    expect(hash).toBe(hashApiKey(rawKey));
  });

  test('honours a custom prefix and is unique per call', () => {
    const a = generateApiKey('tok');
    const b = generateApiKey('tok');
    expect(a.rawKey.startsWith('tok_')).toBe(true);
    expect(a.rawKey).not.toBe(b.rawKey);
  });
});

describe('InMemoryTenantResolver', () => {
  test('resolves a registered key to its tenant', async () => {
    const resolver = new InMemoryTenantResolver();
    const tenantId = randomUUID();
    const { rawKey } = generateApiKey();
    resolver.register(rawKey, tenantId);

    expect(await resolver.resolve(rawKey)).toEqual({ tenant_id: tenantId });
  });

  test('fails closed for unknown or empty keys', async () => {
    const resolver = new InMemoryTenantResolver();
    resolver.register('known', randomUUID());

    expect(await resolver.resolve('unknown')).toBeNull();
    expect(await resolver.resolve('')).toBeNull();
  });

  test('keeps tenants distinct and revokes', async () => {
    const resolver = new InMemoryTenantResolver();
    const [t1, t2] = [randomUUID(), randomUUID()];
    resolver.register('k1', t1);
    resolver.register('k2', t2);

    expect((await resolver.resolve('k1'))?.tenant_id).toBe(t1);
    expect((await resolver.resolve('k2'))?.tenant_id).toBe(t2);

    expect(resolver.revoke('k1')).toBe(true);
    expect(await resolver.resolve('k1')).toBeNull();
    expect(resolver.revoke('k1')).toBe(false);
    // Revoking one key must not affect another.
    expect((await resolver.resolve('k2'))?.tenant_id).toBe(t2);
  });
});

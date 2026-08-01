/**
 * TenantResolver / API-key primitive tests.
 *
 * Pure (no database) — runs everywhere.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  hashApiKey,
  generateApiKey,
  InMemoryTenantResolver,
} from '../src/tenant-resolver.js';

describe('hashApiKey', () => {
  it('is deterministic and hex-encoded sha256', () => {
    const hash = hashApiKey('cyc_sk_abc');

    expect(hash).toBe(hashApiKey('cyc_sk_abc'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes different keys to different digests', () => {
    expect(hashApiKey('a')).not.toBe(hashApiKey('b'));
  });
});

describe('generateApiKey', () => {
  it('mints a prefixed key whose hash matches hashApiKey', () => {
    const { rawKey, hash } = generateApiKey();

    expect(rawKey.startsWith('cyc_sk_')).toBe(true);
    expect(hash).toBe(hashApiKey(rawKey));
  });

  it('honours a custom prefix', () => {
    const { rawKey } = generateApiKey('tok');

    expect(rawKey.startsWith('tok_')).toBe(true);
  });

  it('mints a unique raw key per call', () => {
    const a = generateApiKey('tok');
    const b = generateApiKey('tok');

    expect(a.rawKey).not.toBe(b.rawKey);
  });
});

describe('InMemoryTenantResolver', () => {
  it('resolves a registered key to its tenant', async () => {
    const resolver = new InMemoryTenantResolver();
    const tenantId = randomUUID();
    const { rawKey } = generateApiKey();
    resolver.register(rawKey, tenantId);

    expect(await resolver.resolve(rawKey)).toEqual({ tenant_id: tenantId });
  });

  it('fails closed for an unknown key', async () => {
    const resolver = new InMemoryTenantResolver();
    resolver.register('known', randomUUID());

    expect(await resolver.resolve('unknown')).toBeNull();
  });

  it('fails closed for an empty key', async () => {
    const resolver = new InMemoryTenantResolver();
    resolver.register('known', randomUUID());

    expect(await resolver.resolve('')).toBeNull();
  });

  it('resolves distinct keys to their own tenants', async () => {
    const resolver = new InMemoryTenantResolver();
    const [t1, t2] = [randomUUID(), randomUUID()];
    resolver.register('k1', t1);
    resolver.register('k2', t2);

    expect((await resolver.resolve('k1'))?.tenant_id).toBe(t1);
    expect((await resolver.resolve('k2'))?.tenant_id).toBe(t2);
  });

  it('revoke returns true then removes the mapping', async () => {
    const resolver = new InMemoryTenantResolver();
    resolver.register('k1', randomUUID());

    expect(resolver.revoke('k1')).toBe(true);
    expect(await resolver.resolve('k1')).toBeNull();
  });

  it('revoke returns false for a key that was never registered', () => {
    const resolver = new InMemoryTenantResolver();

    expect(resolver.revoke('missing')).toBe(false);
  });

  it('leaves other keys intact when one is revoked', async () => {
    const resolver = new InMemoryTenantResolver();
    const t2 = randomUUID();
    resolver.register('k1', randomUUID());
    resolver.register('k2', t2);

    resolver.revoke('k1');

    expect((await resolver.resolve('k2'))?.tenant_id).toBe(t2);
  });
});

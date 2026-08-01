/**
 * Tenancy plane-helper tests.
 *
 * `withTenant`'s UUID guard runs before any connection is opened, so it is
 * exercised as a pure unit test that runs everywhere. The valid transaction
 * path and `withPlatform` need a live database and are gated on DATABASE_URL.
 */

import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, withPlatform } from '../src/tenancy.js';
import { TENANT_GUC } from '../src/constants.js';
import { randomUUID } from 'node:crypto';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';

describe('withTenant', () => {
  it('throws before running fn when the tenant id is not a UUID', async () => {
    const fn = vi.fn();

    await expect(withTenant('not-a-uuid', fn)).rejects.toThrow(/must be a UUID/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws for an empty tenant id', async () => {
    const fn = vi.fn();

    await expect(withTenant('', fn)).rejects.toThrow(/must be a UUID/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws for a malformed UUID missing a segment', async () => {
    const fn = vi.fn();

    await expect(
      withTenant('12345678-1234-1234-1234', fn),
    ).rejects.toThrow(/must be a UUID/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe.skipIf(!isDatabaseAvailable())('withTenant (database)', () => {
  setupDatabaseTests();

  it('sets the tenant GUC on the transaction before invoking fn', async () => {
    const tenantId = randomUUID();

    const seen = await withTenant(tenantId, async (tx) => {
      const result = await tx.execute(sql`select current_setting(${TENANT_GUC}, true) as tenant`);
      return (result.rows[0] as { tenant: string }).tenant;
    });

    expect(seen).toBe(tenantId);
  });

  it('returns the value produced by fn', async () => {
    const value = await withTenant(randomUUID(), async () => 'payload');

    expect(value).toBe('payload');
  });
});

describe.skipIf(!isDatabaseAvailable())('withPlatform', () => {
  setupDatabaseTests();

  it('runs fn against a usable platform connection', async () => {
    const one = await withPlatform(async (database) => {
      const result = await database.execute(sql`select 1 as v`);
      return (result.rows[0] as { v: number }).v;
    });

    expect(Number(one)).toBe(1);
  });
});

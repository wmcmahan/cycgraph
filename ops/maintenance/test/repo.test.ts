/**
 * Tests for the repository helpers (src/repo.ts) — chiefly the
 * credential scrub every workflow spawn site relies on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { checksEnv } from '../src/repo.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checksEnv', () => {
  it('drops every database credential from the spawned environment', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pw@prod.example.com:5432/app');
    vi.stubEnv('APP_DATABASE_URL', 'postgres://app:pw@prod.example.com:5432/app');
    vi.stubEnv('PLATFORM_DATABASE_URL', 'postgres://admin:pw@prod.example.com:5432/app');
    vi.stubEnv('SUPABASE_DB_URL', 'postgres://user:pw@db.supabase.co:5432/postgres');

    const env = checksEnv();

    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['APP_DATABASE_URL']).toBeUndefined();
    expect(env['PLATFORM_DATABASE_URL']).toBeUndefined();
    expect(env['SUPABASE_DB_URL']).toBeUndefined();
  });

  it('preserves unrelated variables', () => {
    vi.stubEnv('PATH', '/usr/bin');

    const env = checksEnv();

    expect(env['PATH']).toBe('/usr/bin');
  });

  it('leaves process.env untouched', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/app');

    checksEnv();

    expect(process.env['DATABASE_URL']).toBe('postgres://localhost:5432/app');
  });
});

/**
 * Tests for the repository helpers (src/repo.ts) — chiefly the
 * credential scrub every workflow spawn site relies on and the mention
 * strip that keeps relayed agent prose from dispatching workflows.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WORKFLOW_MENTION, checksEnv, stripMentions } from '../src/repo.js';

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

describe('stripMentions', () => {
  it('neutralizes the workflow mention', () => {
    const relayed = stripMentions(`please ${WORKFLOW_MENTION} take another look`);

    expect(relayed).toBe('please cycgraph take another look');
  });

  it('neutralizes the mention regardless of case', () => {
    const relayed = stripMentions('@CycGraph and @CYCGRAPH and @cycgraph');

    expect(relayed).toBe('cycgraph and cycgraph and cycgraph');
  });

  it('neutralizes every occurrence in the text', () => {
    const relayed = stripMentions('@cycgraph @cycgraph @cycgraph');

    expect(relayed).toBe('cycgraph cycgraph cycgraph');
  });

  it('neutralizes the mention when punctuation follows it', () => {
    const relayed = stripMentions('@cycgraph: revise, then @cycgraph-bot, then @cycgraph.');

    expect(relayed).toBe('cycgraph: revise, then cycgraph-bot, then cycgraph.');
  });

  it('neutralizes the mention when it is embedded in surrounding text', () => {
    const relayed = stripMentions('quoted from the PR body: "ping@cycgraph"');

    expect(relayed).toBe('quoted from the PR body: "pingcycgraph"');
  });

  it('leaves text without the mention unchanged', () => {
    const relayed = stripMentions('cycgraph reviewed the diff and @other was mentioned');

    expect(relayed).toBe('cycgraph reviewed the diff and @other was mentioned');
  });

  it('returns empty text unchanged', () => {
    const relayed = stripMentions('');

    expect(relayed).toBe('');
  });
});

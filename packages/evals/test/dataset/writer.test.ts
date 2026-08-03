import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createSqliteBuffer, writeGoldenDataset } from '../../src/dataset/writer.js';
import { loadManifest, loadGoldenTrajectories } from '../../src/dataset/loader.js';
import type { GoldenTrajectory } from '../../src/dataset/types.js';

function makeTrajectory(overrides: Partial<GoldenTrajectory> = {}): GoldenTrajectory {
  return {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Test trajectory',
    input: 'Test input',
    expectedOutput: 'Test output',
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

const TEST_DIR = resolve(import.meta.dirname, '../.test-golden-writer');

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('createSqliteBuffer', () => {
  it('serializes trajectories into a queryable trajectories table', () => {
    const trajectories = [makeTrajectory({ description: 'first' }), makeTrajectory({ description: 'second' })];

    const buffer = createSqliteBuffer(trajectories);

    const db = new Database(buffer);
    const rows = db.prepare('SELECT id, data FROM trajectories').all() as Array<{ id: string; data: string }>;
    db.close();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].data).description).toBe('first');
  });

  it('produces an empty table for no trajectories', () => {
    const buffer = createSqliteBuffer([]);

    const db = new Database(buffer);
    const count = db.prepare('SELECT COUNT(*) AS n FROM trajectories').get() as { n: number };
    db.close();
    expect(count.n).toBe(0);
  });
});

describe('writeGoldenDataset', () => {
  it('writes a dataset that loads back through the loader', () => {
    const trajectories = [makeTrajectory()];

    writeGoldenDataset('orchestrator', trajectories, '1.0.0', TEST_DIR);

    const loaded = loadGoldenTrajectories('orchestrator', TEST_DIR);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(trajectories[0].id);
  });

  it('falls back to major version 1 when the schema version has no leading digits', () => {
    writeGoldenDataset('orchestrator', [makeTrajectory()], 'unstable', TEST_DIR);

    expect(existsSync(resolve(TEST_DIR, 'data/orchestrator-v1.sqlite.gz'))).toBe(true);
    const entry = loadManifest(TEST_DIR).datasets.find(d => d.name === 'orchestrator')!;
    expect(entry.file).toBe('data/orchestrator-v1.sqlite.gz');
    expect(entry.schemaVersion).toBe('unstable');
  });

  it('rejects trajectories that fail schema validation before writing', () => {
    const invalid = { ...makeTrajectory(), id: 'not-a-uuid' } as GoldenTrajectory;

    expect(() => writeGoldenDataset('orchestrator', [invalid], '1.0.0', TEST_DIR)).toThrow();
    expect(existsSync(resolve(TEST_DIR, 'manifest.json'))).toBe(false);
  });

  it('replaces the existing entry when rewriting the same suite and major version', () => {
    writeGoldenDataset('orchestrator', [makeTrajectory()], '1.0.0', TEST_DIR);
    writeGoldenDataset('orchestrator', [makeTrajectory(), makeTrajectory()], '1.1.0', TEST_DIR);

    const datasets = loadManifest(TEST_DIR).datasets.filter(d => d.name === 'orchestrator');
    expect(datasets).toHaveLength(1);
    expect(datasets[0].trajectoryCount).toBe(2);
    expect(datasets[0].schemaVersion).toBe('1.1.0');
  });
});

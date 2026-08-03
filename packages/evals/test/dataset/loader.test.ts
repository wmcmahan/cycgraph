import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { loadManifest, loadGoldenTrajectories, listAvailableSuites } from '../../src/dataset/loader.js';
import { writeGoldenDataset } from '../../src/dataset/writer.js';
import type { GoldenTrajectory } from '../../src/dataset/types.js';

function writeRawDataset(goldenDir: string, suite: string, rows: Array<{ id: string; data: string }>): void {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE trajectories (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO trajectories (id, data) VALUES (?, ?)');
  for (const row of rows) insert.run(row.id, row.data);
  const compressed = gzipSync(Buffer.from(db.serialize()));
  db.close();

  const file = `data/${suite}-v1.sqlite.gz`;
  mkdirSync(resolve(goldenDir, 'data'), { recursive: true });
  writeFileSync(resolve(goldenDir, file), compressed);
  writeFileSync(
    resolve(goldenDir, 'manifest.json'),
    JSON.stringify({
      version: '1',
      datasets: [
        {
          name: suite,
          file,
          sha256: createHash('sha256').update(compressed).digest('hex'),
          trajectoryCount: rows.length,
          schemaVersion: '1.0.0',
          lastUpdated: '2026-04-01T00:00:00Z',
        },
      ],
    }),
  );
}

const TEST_GOLDEN_DIR = resolve(import.meta.dirname, '../.test-golden');

const sampleTrajectories: GoldenTrajectory[] = [
  {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Test trajectory 1',
    input: 'Test input 1',
    expectedOutput: 'Test output 1',
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
  },
  {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Test trajectory 2',
    input: 'Test input 2',
    expectedOutput: { key: 'structured output' },
    expectedToolCalls: [{ toolName: 'web_search', args: { query: 'test' } }],
    tags: ['test'],
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
  },
];

beforeAll(() => {
  mkdirSync(resolve(TEST_GOLDEN_DIR, 'data'), { recursive: true });
  writeGoldenDataset('orchestrator', sampleTrajectories, '1.0.0', TEST_GOLDEN_DIR);
});

afterAll(() => {
  rmSync(TEST_GOLDEN_DIR, { recursive: true, force: true });
});

describe('loadManifest', () => {
  it('loads and validates the manifest', () => {
    const manifest = loadManifest(TEST_GOLDEN_DIR);

    expect(manifest.version).toBe('1');
    expect(manifest.datasets).toHaveLength(1);
    expect(manifest.datasets[0].name).toBe('orchestrator');
    expect(manifest.datasets[0].trajectoryCount).toBe(2);
  });

  it('throws on missing manifest', () => {
    expect(() => loadManifest('/nonexistent/path')).toThrow();
  });
});

describe('loadGoldenTrajectories', () => {
  it('loads and validates trajectories from compressed SQLite', () => {
    const trajectories = loadGoldenTrajectories('orchestrator', TEST_GOLDEN_DIR);

    expect(trajectories).toHaveLength(2);
    expect(trajectories[0].suite).toBe('orchestrator');
    expect(trajectories[0].description).toBe('Test trajectory 1');
    expect(trajectories[1].expectedOutput).toEqual({ key: 'structured output' });
    expect(trajectories[1].expectedToolCalls).toHaveLength(1);
  });

  it('throws for a suite not in the manifest', () => {
    expect(() => loadGoldenTrajectories('memory', TEST_GOLDEN_DIR)).toThrow(
      /Suite "memory" not found in manifest/,
    );
  });

  it('reports "(none)" available when the manifest has no datasets', () => {
    const emptyDir = resolve(import.meta.dirname, '../.test-golden-empty');
    mkdirSync(emptyDir, { recursive: true });
    try {
      writeFileSync(
        resolve(emptyDir, 'manifest.json'),
        JSON.stringify({ version: '1', datasets: [] }),
      );

      expect(() => loadGoldenTrajectories('orchestrator', emptyDir)).toThrow(/Available: \(none\)/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('throws when a stored trajectory fails schema validation', () => {
    const badDir = resolve(import.meta.dirname, '../.test-golden-invalid');
    try {
      writeRawDataset(badDir, 'orchestrator', [
        { id: 'not-a-uuid', data: JSON.stringify({ id: 'not-a-uuid', suite: 'orchestrator' }) },
      ]);

      expect(() => loadGoldenTrajectories('orchestrator', badDir)).toThrow(
        /Trajectory at index 0 in suite "orchestrator" failed validation/,
      );
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered dataset (checksum mismatch)', () => {
    const entry = loadManifest(TEST_GOLDEN_DIR).datasets.find(d => d.name === 'orchestrator')!;
    const filePath = resolve(TEST_GOLDEN_DIR, entry.file);
    const original = readFileSync(filePath);
    try {
      writeFileSync(filePath, Buffer.concat([original, Buffer.from([0x00])]));
      expect(() => loadGoldenTrajectories('orchestrator', TEST_GOLDEN_DIR)).toThrow(
        /failed integrity check/,
      );
    } finally {
      writeFileSync(filePath, original); // restore for later tests
    }
  });
});

describe('writeGoldenDataset versioning', () => {
  it('derives the filename from the schema major version so versions coexist', () => {
    const dir = resolve(import.meta.dirname, '../.test-golden-versions');
    mkdirSync(resolve(dir, 'data'), { recursive: true });
    try {
      writeGoldenDataset('orchestrator', sampleTrajectories, '1.0.0', dir);
      writeGoldenDataset('orchestrator', sampleTrajectories, '2.0.0', dir);

      expect(existsSync(resolve(dir, 'data/orchestrator-v1.sqlite.gz'))).toBe(true);
      expect(existsSync(resolve(dir, 'data/orchestrator-v2.sqlite.gz'))).toBe(true);

      const manifest = loadManifest(dir);
      const entry = manifest.datasets.find(d => d.name === 'orchestrator')!;
      expect(entry.file).toBe('data/orchestrator-v2.sqlite.gz');
      expect(entry.schemaVersion).toBe('2.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listAvailableSuites', () => {
  it('returns suite names from the manifest', () => {
    const suites = listAvailableSuites(TEST_GOLDEN_DIR);

    expect(suites).toEqual(['orchestrator']);
  });
});

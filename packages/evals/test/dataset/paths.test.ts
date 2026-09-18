import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDatasetPath } from '../../src/dataset/paths.js';

const ROOT = resolve(import.meta.dirname, '../.test-paths');
const GOLDEN_DIR = resolve(ROOT, 'golden');

beforeEach(() => {
  mkdirSync(resolve(GOLDEN_DIR, 'data'), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('resolveDatasetPath', () => {
  it('resolves a data/-relative file to an absolute path inside the golden directory', () => {
    const file = 'data/orchestrator-v1.sqlite.gz';
    writeFileSync(resolve(GOLDEN_DIR, file), 'payload');

    const resolved = resolveDatasetPath(GOLDEN_DIR, file);

    expect(resolved).toBe(resolve(realpathSync(GOLDEN_DIR), file));
  });

  it('resolves a file that does not exist yet without touching the filesystem', () => {
    const resolved = resolveDatasetPath(GOLDEN_DIR, 'data/absent-v1.sqlite.gz');

    expect(resolved).toBe(resolve(GOLDEN_DIR, 'data/absent-v1.sqlite.gz'));
  });

  it('rejects a lexical escape via parent-directory segments', () => {
    expect(() => resolveDatasetPath(GOLDEN_DIR, '../../../../etc/passwd')).toThrow(
      /escapes the golden directory/,
    );
  });

  it('rejects a lexical escape nested after a valid prefix', () => {
    expect(() => resolveDatasetPath(GOLDEN_DIR, 'data/../../secrets.sqlite.gz')).toThrow(
      /escapes the golden directory/,
    );
  });

  it('rejects an absolute path', () => {
    expect(() => resolveDatasetPath(GOLDEN_DIR, '/etc/passwd')).toThrow(
      /escapes the golden directory/,
    );
  });

  it('rejects the golden directory itself', () => {
    expect(() => resolveDatasetPath(GOLDEN_DIR, '.')).toThrow(/escapes the golden directory/);
  });

  it('rejects a symlink inside the golden directory that points out of it', () => {
    const outside = resolve(ROOT, 'outside.sqlite.gz');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, resolve(GOLDEN_DIR, 'data/escape-v1.sqlite.gz'));

    expect(() => resolveDatasetPath(GOLDEN_DIR, 'data/escape-v1.sqlite.gz')).toThrow(
      /resolves outside the golden directory/,
    );
  });

  it('accepts a symlink inside the golden directory that points back into it', () => {
    const target = resolve(GOLDEN_DIR, 'data/orchestrator-v1.sqlite.gz');
    writeFileSync(target, 'payload');
    symlinkSync(target, resolve(GOLDEN_DIR, 'data/alias-v1.sqlite.gz'));

    const resolved = resolveDatasetPath(GOLDEN_DIR, 'data/alias-v1.sqlite.gz');

    expect(resolved).toBe(realpathSync(target));
  });

  it('rejects a symlinked subdirectory inside the golden directory that points out of it', () => {
    const outsideDir = resolve(ROOT, 'elsewhere');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(resolve(outsideDir, 'leak-v1.sqlite.gz'), 'secret');
    symlinkSync(outsideDir, resolve(GOLDEN_DIR, 'linked'));

    expect(() => resolveDatasetPath(GOLDEN_DIR, 'linked/leak-v1.sqlite.gz')).toThrow(
      /resolves outside the golden directory/,
    );
  });
});

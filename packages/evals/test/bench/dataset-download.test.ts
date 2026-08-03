/**
 * Dataset downloader tests.
 *
 * `fetchHotpotQA` / `fetchMusique` are network + filesystem driver code.
 * We stub `globalThis.fetch` and intercept only bench-data filesystem
 * paths with an in-memory map (every other path delegates to the real fs
 * so unrelated modules keep working), then assert the reachable logic:
 * cache-hit skip, HTTP error handling, and MuSiQue's sha256 gate.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { fetchHotpotQA } from '../../src/bench/dataset/hotpotqa.js';
import { fetchMusique } from '../../src/bench/dataset/musique.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const mem = new Map<string, string>();
  const isBench = (p: unknown): boolean => String(p).includes('bench-data');
  return {
    ...actual,
    __mem: mem,
    existsSync: (p: string) => (isBench(p) ? mem.has(String(p)) : actual.existsSync(p)),
    mkdirSync: (p: string, o: unknown) => (isBench(p) ? undefined : (actual.mkdirSync as (a: string, b: unknown) => unknown)(p, o)),
    writeFileSync: (p: string, d: string) =>
      isBench(p) ? void mem.set(String(p), String(d)) : actual.writeFileSync(p, d),
    readFileSync: (p: string, e?: unknown) =>
      isBench(p) ? mem.get(String(p)) : (actual.readFileSync as (a: string, b?: unknown) => unknown)(p, e),
  };
});

const mem = (fs as unknown as { __mem: Map<string, string> }).__mem;
const originalFetch = globalThis.fetch;

function okResponse(body: string): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => body } as Response;
}

function errorResponse(status: number, statusText: string): Response {
  return { ok: false, status, statusText, text: async () => '' } as Response;
}

beforeEach(() => {
  mem.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchHotpotQA', () => {
  it('downloads and caches the raw file when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('[]'));
    globalThis.fetch = fetchMock as typeof fetch;

    const path = await fetchHotpotQA('https://example.test/hotpot.json');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mem.get(path)).toBe('[]');
  });

  it('skips the download when the file is already cached', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('[]'));
    globalThis.fetch = fetchMock as typeof fetch;

    await fetchHotpotQA('https://example.test/hotpot.json');
    await fetchHotpotQA('https://example.test/hotpot.json');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws with the HTTP status when the download fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(404, 'Not Found')) as typeof fetch;

    await expect(fetchHotpotQA('https://example.test/hotpot.json')).rejects.toThrow(
      /HotpotQA download failed: 404 Not Found/,
    );
  });
});

describe('fetchMusique', () => {
  it('downloads and caches the raw file when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('{}\n'));
    globalThis.fetch = fetchMock as typeof fetch;

    const path = await fetchMusique('https://example.test/musique.jsonl');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mem.get(path)).toBe('{}\n');
  });

  it('throws with the HTTP status when the download fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(500, 'Server Error')) as typeof fetch;

    await expect(fetchMusique('https://example.test/musique.jsonl')).rejects.toThrow(
      /MuSiQue download failed: 500 Server Error/,
    );
  });

  it('passes sha256 verification when the content hash matches', async () => {
    const body = 'known musique content\n';
    const digest = createHash('sha256').update(body).digest('hex');
    globalThis.fetch = vi.fn().mockResolvedValue(okResponse(body)) as typeof fetch;

    await expect(fetchMusique('https://example.test/musique.jsonl', digest)).resolves.toBeDefined();
  });

  it('throws on a sha256 mismatch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okResponse('unexpected content')) as typeof fetch;

    await expect(
      fetchMusique('https://example.test/musique.jsonl', 'a'.repeat(64)),
    ).rejects.toThrow(/hash mismatch/);
  });

  it('skips the download but still verifies a cached file', async () => {
    const body = 'cached content\n';
    const digest = createHash('sha256').update(body).digest('hex');
    const fetchMock = vi.fn().mockResolvedValue(okResponse(body));
    globalThis.fetch = fetchMock as typeof fetch;

    await fetchMusique('https://example.test/musique.jsonl');
    await fetchMusique('https://example.test/musique.jsonl', digest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

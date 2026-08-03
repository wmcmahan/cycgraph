/**
 * LLMLingua-2 adapter tests.
 *
 * The adapter bridges to a persistent Python child process over
 * line-delimited JSON. We mock `node:child_process` with a fake process
 * whose stdout is a real stream (so the adapter's real `readline` parsing
 * runs) and drive the protocol: emit a `ready` line on spawn, then answer
 * each stdin write with a queued response line. `available()` is driven by
 * a stubbed `spawnSync`. The model download / load path is not reachable
 * without the real engine and is left uncovered by design.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

let responseQueue: string[] = [];
let spawnSyncStatus = 0;
let readyLine = JSON.stringify({ ready: true });

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  stdin = {
    write: vi.fn(() => {
      const line = responseQueue.shift();
      if (line !== undefined) queueMicrotask(() => this.stdout.write(line + '\n'));
      return true;
    }),
    end: vi.fn(),
  };
  kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit('close');
  });
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new FakeProc();
    queueMicrotask(() => proc.stdout.write(readyLine + '\n'));
    return proc;
  }),
  spawnSync: vi.fn(() => ({ status: spawnSyncStatus })),
}));

const { llmlinguaAdapter, stopLlmlinguaBridge, nextCalibratedTarget } = await import(
  '../../src/bench/adapters/llmlingua.js'
);
const { SMOKE_QUESTIONS } = await import('../../src/bench/dataset/hotpotqa.js');

const question = SMOKE_QUESTIONS[0];

afterEach(() => {
  stopLlmlinguaBridge();
  responseQueue = [];
  spawnSyncStatus = 0;
  readyLine = JSON.stringify({ ready: true });
});

describe('nextCalibratedTarget', () => {
  it('scales the target toward the budget with an undershoot bias', () => {
    const next = nextCalibratedTarget(700, 940, 700);

    expect(next).toBeLessThan(700 * (700 / 940));
    expect(next).toBeGreaterThan(400);
  });

  it('never returns below the floor of 8', () => {
    expect(nextCalibratedTarget(10, 10_000, 10)).toBe(8);
  });
});

describe('llmlinguaAdapter.available', () => {
  it('is true when the interpreter can import llmlingua', async () => {
    spawnSyncStatus = 0;

    expect(await llmlinguaAdapter.available()).toBe(true);
  });

  it('is false when the import probe exits non-zero', async () => {
    spawnSyncStatus = 1;

    expect(await llmlinguaAdapter.available()).toBe(false);
  });
});

describe('llmlinguaAdapter.compress', () => {
  it('returns the bridge output when it already fits the budget', async () => {
    responseQueue = [JSON.stringify({ compressed: 'Northgate is in Denver.' })];

    const output = await llmlinguaAdapter.compress(question, 10_000);

    expect(output.compressed).toBe('Northgate is in Denver.');
    expect(output.outputTokens).toBeGreaterThan(0);
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('recalibrates and re-requests when the first output overshoots the budget', async () => {
    const oversized = 'word '.repeat(80);
    responseQueue = [
      JSON.stringify({ compressed: oversized }),
      JSON.stringify({ compressed: 'tiny' }),
    ];

    const output = await llmlinguaAdapter.compress(question, 5);

    expect(output.compressed).toBe('tiny');
  });

  it('throws when the bridge reports an error', async () => {
    responseQueue = [JSON.stringify({ error: 'model blew up' })];

    await expect(llmlinguaAdapter.compress(question, 10_000)).rejects.toThrow(
      /llmlingua compression failed: model blew up/,
    );
  });

  it('throws when the bridge emits a non-JSON response line', async () => {
    responseQueue = ['this is not json'];

    await expect(llmlinguaAdapter.compress(question, 10_000)).rejects.toThrow(
      /returned non-JSON/,
    );
  });

  it('throws when the bridge never signals ready', async () => {
    readyLine = JSON.stringify({ ready: false, error: 'model failed to load' });
    responseQueue = [JSON.stringify({ compressed: 'unused' })];

    await expect(llmlinguaAdapter.compress(question, 10_000)).rejects.toThrow(
      /failed to start: model failed to load/,
    );
  });
});

describe('stopLlmlinguaBridge', () => {
  it('is safe to call when no bridge has started', () => {
    expect(() => stopLlmlinguaBridge()).not.toThrow();
  });
});

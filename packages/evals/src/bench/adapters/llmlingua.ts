/**
 * LLMLingua-2 Adapter (external competitor)
 *
 * Bridges to Microsoft's LLMLingua-2 (Python) — the main published
 * prompt-compression engine to compare against. The bridge is a
 * persistent line-delimited JSON server so the ~2GB model loads once per
 * benchmark run, not once per compression.
 *
 * Availability is probed (`import llmlingua` in the resolved interpreter);
 * when unavailable, the benchmark marks the adapter skipped rather than
 * silently omitting it.
 *
 * Setup: `npm run bench:setup-llmlingua`. Interpreter resolution:
 * `BENCH_PYTHON` env var → the setup venv → `python3` on PATH.
 * Default settings on both sides — no tuning.
 *
 * @module bench/adapters/llmlingua
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchQuestion, CompressorAdapter, CompressionOutput } from '../types.js';
import { countTokens } from '../token-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = resolve(__dirname, 'llmlingua_bridge.py');
/** Conventional venv created by `npm run bench:setup-llmlingua`. */
const VENV_PYTHON = resolve(__dirname, '../../../bench-data/llmlingua-venv/bin/python');

/** Resolution order: explicit env var, then the setup-script venv, then PATH. */
function resolvePython(): string {
  if (process.env.BENCH_PYTHON) return process.env.BENCH_PYTHON;
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON;
  return 'python3';
}

const PYTHON = resolvePython();

/** First-request timeout covers model download + load; later ones are inference only. */
const FIRST_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

interface BridgeResponse {
  ready?: boolean;
  compressed?: string;
  error?: string;
}

/**
 * Persistent bridge process. Requests are serialized (one in flight) —
 * the protocol is one response line per request line, in order.
 */
class BridgeServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  /** Rolling stderr tail — one listener for the process lifetime. */
  private stderrTail = '';

  private async ensureStarted(): Promise<void> {
    if (this.started && this.proc && this.proc.exitCode === null) return;

    this.proc = spawn(PYTHON, [BRIDGE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = createInterface({ input: this.proc.stdout });
    this.stderrTail = '';
    this.proc.stderr.on('data', d => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-2000);
    });
    this.proc.on('close', () => {
      this.started = false;
    });

    // Wait for the ready line (model download + load on first ever run).
    const ready = await this.readLine(FIRST_REQUEST_TIMEOUT_MS, () => this.stderrTail);
    if (!ready.ready) {
      throw new Error(`llmlingua bridge failed to start: ${ready.error ?? 'no ready signal'}`);
    }
    this.started = true;
  }

  private readLine(timeoutMs: number, stderr: () => string): Promise<BridgeResponse> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`llmlingua bridge timed out after ${timeoutMs}ms. stderr: ${stderr().slice(-500)}`));
      }, timeoutMs);

      const onLine = (line: string) => {
        cleanup();
        try {
          resolvePromise(JSON.parse(line) as BridgeResponse);
        } catch {
          reject(new Error(`llmlingua bridge returned non-JSON: ${line.slice(0, 200)}`));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`llmlingua bridge exited. stderr: ${stderr().slice(-500)}`));
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.lines?.off('line', onLine);
        this.proc?.off('close', onClose);
      };

      this.lines?.once('line', onLine);
      this.proc?.once('close', onClose);
    });
  }

  /** Send one compression request (serialized behind any in-flight one). */
  compress(context: string, targetTokens: number): Promise<string> {
    const run = async (): Promise<string> => {
      await this.ensureStarted();
      this.proc!.stdin.write(JSON.stringify({ context, target_tokens: targetTokens }) + '\n');
      const response = await this.readLine(REQUEST_TIMEOUT_MS, () => this.stderrTail);
      if (response.error !== undefined || response.compressed === undefined) {
        throw new Error(`llmlingua compression failed: ${response.error ?? 'empty response'}`);
      }
      return response.compressed;
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  stop(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.started = false;
  }
}

const server = new BridgeServer();

/** Stop the persistent bridge (called by the runner at shutdown; safe to skip). */
export function stopLlmlinguaBridge(): void {
  server.stop();
}

/** Overshoot tolerance before re-requesting (matches the harness's cell tolerance). */
const BUDGET_TOLERANCE = 1.05;
/** Max calibration re-requests per compression. */
const MAX_CALIBRATION_ATTEMPTS = 3;

/**
 * Next `target_token` to request when the previous attempt overshot the
 * budget as measured by the SHARED counter. Scales proportionally with a
 * 5% undershoot bias so the loop converges instead of oscillating.
 */
export function nextCalibratedTarget(
  currentTarget: number,
  achievedTokens: number,
  budgetTokens: number,
): number {
  return Math.max(8, Math.floor(currentTarget * (budgetTokens / achievedTokens) * 0.95));
}

export const llmlinguaAdapter: CompressorAdapter = {
  name: 'llmlingua-2',
  version: 'llmlingua-2 (python bridge, default settings)',
  async available() {
    const probe = spawnSync(PYTHON, ['-c', 'import llmlingua'], { timeout: 60_000 });
    return probe.status === 0;
  },
  async compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput> {
    const context = question.documents.map(d => `${d.title}\n${d.text}`).join('\n\n');
    const start = performance.now();

    // LLMLingua treats `target_token` as advisory and measures with its own
    // tokenizer, so a single request can overshoot the shared-ruler budget by
    // 30%+ (measured: target 0.7 → achieved 0.94). Every other adapter is
    // held to the budget by the shared counter — hold this one to it the
    // same way: scale the target down and re-request until the output fits.
    // durationMs includes the retries; that's the honest cost of reaching
    // the budget with this engine.
    let target = budgetTokens;
    let compressed = await server.compress(context, target);
    let outputTokens = countTokens(compressed);

    for (
      let attempt = 0;
      attempt < MAX_CALIBRATION_ATTEMPTS && outputTokens > budgetTokens * BUDGET_TOLERANCE;
      attempt++
    ) {
      target = nextCalibratedTarget(target, outputTokens, budgetTokens);
      compressed = await server.compress(context, target);
      outputTokens = countTokens(compressed);
    }

    return {
      compressed,
      outputTokens,
      durationMs: performance.now() - start,
    };
  },
};

/**
 * sandboxed_js — WASM-sandboxed JavaScript evaluation
 *
 * Untrusted code is interpreted by QuickJS compiled to WebAssembly, so its
 * entire world is a bounds-checked linear memory with no host imports beyond
 * a string-only log bridge. That WASM engine runs inside a `worker_threads`
 * worker the parent terminates at the deadline, because `evalCode` is
 * synchronous and the in-engine interrupt handler needs a backstop outside
 * the engine.
 *
 * WASM decides what the code can touch; the worker decides what it can block
 * and how it dies.
 *
 * @module sandbox/sandboxed-js
 */

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Options for {@link sandboxedJsTool}. */
export interface SandboxedJsToolOptions {
  /** Interrupt-handler deadline for guest execution. @default 2000 */
  deadlineMs?: number;
  /** QuickJS runtime memory limit in bytes. @default 64 MiB */
  memoryLimitBytes?: number;
  /** QuickJS max stack size in bytes. @default 512 KiB */
  maxStackBytes?: number;
  /** Cap on submitted code size. @default 50 KiB */
  maxCodeBytes?: number;
  /** Cap on serialized input size. @default 1 MiB */
  maxInputBytes?: number;
  /** Cap on the JSON-serialized result. Over-cap is an error, not truncation. @default 1 MiB */
  maxResultBytes?: number;
  /** Cap on captured console.log entries. @default 100 */
  maxLogEntries?: number;
  /**
   * Margin beyond `deadlineMs` before the worker is force-terminated, covering
   * WASM init and teardown. The in-engine interrupt handler normally fires
   * first; this is the outside-the-engine backstop. @default 3000
   */
  terminateMarginMs?: number;
  /** Set to taint-track sandbox output. @default false */
  taints?: boolean;
}

/** Default margin beyond the deadline before the worker is terminated. */
const DEFAULT_TERMINATE_MARGIN_MS = 3_000;

/** Per-entry cap on captured log lines, in UTF-16 code units. */
const MAX_LOG_ENTRY_LENGTH = 1_024;

/**
 * Worker body (CJS, `eval: true`). The engine module path is resolved
 * host-side and passed in, so resolution never depends on the worker's cwd.
 * One runtime and context per call, disposed in `finally` — runtimes are
 * never reused across executions (design-doc checklist item).
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const {
  enginePath, code, inputJson, deadlineMs,
  memoryLimitBytes, maxStackBytes, maxResultBytes, maxLogEntries, maxLogEntryLength,
} = workerData;

(async () => {
  const { getQuickJS } = require(enginePath);
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  const logs = [];
  let context;
  try {
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(maxStackBytes);
    const deadline = Date.now() + deadlineMs;
    runtime.setInterruptHandler(() => Date.now() >= deadline);

    context = runtime.newContext();

    // The single host function crossing the boundary: string-only, capped.
    const logFn = context.newFunction('__log', (handle) => {
      if (context.typeof(handle) !== 'string') {
        throw new Error('__log accepts strings only');
      }
      if (logs.length < maxLogEntries) {
        logs.push(context.getString(handle).slice(0, maxLogEntryLength));
      }
    });
    context.setProp(context.global, '__log', logFn);
    logFn.dispose();

    // Guest bootstrap: console wrapper (stringifies before crossing the
    // bridge) and the input global, parsed guest-side from a JSON string so
    // no object graph crosses the boundary by reference.
    if (inputJson !== undefined) {
      const inputHandle = context.newString(inputJson);
      context.setProp(context.global, '__inputJson', inputHandle);
      inputHandle.dispose();
    }
    const bootstrap = context.evalCode(
      // Remove multi-threading / shared-memory primitives the engine exposes
      // but the design doc forbids (no worker parallelism, no timing side
      // channels via shared buffers).
      'delete globalThis.SharedArrayBuffer; delete globalThis.Atomics;' +
      'globalThis.console = { log: (...args) => __log(args.map(a => typeof a === "string" ? a : JSON.stringify(a) ?? String(a)).join(" ")) };' +
      'globalThis.input = typeof __inputJson === "string" ? JSON.parse(__inputJson) : undefined;' +
      'delete globalThis.__inputJson;'
    );
    if (bootstrap.error) { bootstrap.error.dispose(); throw new Error('sandbox bootstrap failed'); }
    bootstrap.value.dispose();

    const evaluated = context.evalCode(code);
    if (evaluated.error) {
      const err = context.dump(evaluated.error);
      evaluated.error.dispose();
      const message = err && typeof err === 'object' ? (err.message ?? JSON.stringify(err)) : String(err);
      const kind = String(message).includes('interrupted')
        ? 'Execution exceeded the ' + deadlineMs + 'ms deadline and was interrupted'
        : 'Execution failed: ' + message;
      parentPort.postMessage({ ok: false, error: kind, logs });
      return;
    }
    context.setProp(context.global, '__completion', evaluated.value);
    evaluated.value.dispose();

    // Serialize guest-side so cycles, functions, and Promises are rejected
    // by guest semantics before anything crosses the boundary.
    const serialized = context.evalCode(
      '(() => {' +
      '  const c = globalThis.__completion;' +
      '  if (c && typeof c.then === "function") throw new Error("Promise completion values are not supported (sandboxed_js is synchronous)");' +
      '  const s = JSON.stringify(c === undefined ? null : c);' +
      '  if (s === undefined) throw new Error("Result is not JSON-serializable");' +
      '  return s;' +
      '})()'
    );
    if (serialized.error) {
      const err = context.dump(serialized.error);
      serialized.error.dispose();
      const message = err && typeof err === 'object' ? (err.message ?? JSON.stringify(err)) : String(err);
      parentPort.postMessage({ ok: false, error: 'Result serialization failed: ' + message, logs });
      return;
    }
    const resultJson = context.getString(serialized.value);
    serialized.value.dispose();

    if (resultJson.length > maxResultBytes) {
      parentPort.postMessage({
        ok: false,
        error: 'Result (' + resultJson.length + ' bytes) exceeds the ' + maxResultBytes + '-byte cap',
        logs,
      });
      return;
    }
    parentPort.postMessage({ ok: true, resultJson, logs });
  } finally {
    if (context) context.dispose();
    runtime.dispose();
  }
})().catch((err) => {
  parentPort.postMessage({ ok: false, error: String(err && err.message ? err.message : err), logs: [] });
});
`;

interface WorkerReply {
  ok: boolean;
  resultJson?: string;
  error?: string;
  logs: string[];
}

function runInSandboxWorker(
  workerData: Record<string, unknown>,
  killAfterMs: number,
): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`Sandbox worker exceeded ${killAfterMs}ms and was terminated`));
    }, killAfterMs);

    worker.once('message', (reply: WorkerReply) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(reply);
    });
    // Defensive: the worker body wraps everything in a catch-all that posts a
    // message, so this fires only for an exception that bypasses it (e.g. a
    // failure before the IIFE runs). Kept as a last-resort guard.
    worker.once('error', (err) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Create the `sandboxed_js` tool. See the design doc for the threat model,
 * limits rationale, and the exhaustive guest environment.
 */
export function sandboxedJsTool(options: SandboxedJsToolOptions = {}): DefinedTool {
  const deadlineMs = options.deadlineMs ?? 2_000;
  const memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024;
  const maxStackBytes = options.maxStackBytes ?? 512 * 1024;
  const maxCodeBytes = options.maxCodeBytes ?? 50 * 1024;
  const maxInputBytes = options.maxInputBytes ?? 1024 * 1024;
  const maxResultBytes = options.maxResultBytes ?? 1024 * 1024;
  const maxLogEntries = options.maxLogEntries ?? 100;
  const terminateMarginMs = options.terminateMarginMs ?? DEFAULT_TERMINATE_MARGIN_MS;

  // Resolve the engine entry point HERE, against this module's own
  // resolution chain — an eval'd worker's require() resolves from the
  // process cwd, which for a published package points anywhere.
  const enginePath = createRequire(import.meta.url).resolve('quickjs-emscripten');

  return defineTool({
    name: 'sandboxed_js',
    description:
      'Evaluate JavaScript in a WASM sandbox (no filesystem, network, timers, or modules). ' +
      'The last expression is the result and must be JSON-serializable. Optional JSON data ' +
      'is available as the global `input`. console.log output is captured.',
    parameters: z.object({
      code: z.string().min(1).describe('JavaScript program; the last expression is the result'),
      input: z.unknown().optional().describe('JSON data exposed to the code as `input`'),
    }),
    taints: options.taints ?? false,
    // Backstop: must exceed deadline + termination margin so the outer race
    // never fires first in normal operation (design-doc checklist item).
    timeoutMs: deadlineMs + terminateMarginMs + 2_000,
    execute: async ({ code, input }) => {
      if (code.length > maxCodeBytes) {
        throw new Error(`Code (${code.length} bytes) exceeds the ${maxCodeBytes}-byte cap`);
      }
      let inputJson: string | undefined;
      if (input !== undefined) {
        inputJson = JSON.stringify(input);
        if (inputJson === undefined) throw new Error('input is not JSON-serializable');
        if (inputJson.length > maxInputBytes) {
          throw new Error(`input (${inputJson.length} bytes) exceeds the ${maxInputBytes}-byte cap`);
        }
      }

      const reply = await runInSandboxWorker(
        {
          enginePath,
          code,
          inputJson,
          deadlineMs,
          memoryLimitBytes,
          maxStackBytes,
          maxResultBytes,
          maxLogEntries,
          maxLogEntryLength: MAX_LOG_ENTRY_LENGTH,
        },
        deadlineMs + terminateMarginMs,
      );

      if (!reply.ok) {
        throw new Error(reply.error ?? 'Sandbox execution failed');
      }
      return { result: JSON.parse(reply.resultJson ?? 'null') as unknown, logs: reply.logs };
    },
  });
}

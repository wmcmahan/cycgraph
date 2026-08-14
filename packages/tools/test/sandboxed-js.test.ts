/**
 * Tests for sandboxed_js (src/sandbox/sandboxed-js.ts): functional
 * evaluation, the limit set from the design doc, and the escape probes
 * from its security-review checklist. Every test runs a real QuickJS WASM
 * instance in a real worker.
 */

import { describe, it, expect } from 'vitest';
import { GraphRunner, createGraph, createWorkflowState } from '@cycgraph/orchestrator';
import { sandboxedJsTool } from '../src/sandbox/sandboxed-js.js';

type SandboxResult = { result: unknown; logs: string[] };

const tool = sandboxedJsTool();

async function run(code: string, input?: unknown): Promise<SandboxResult> {
  return (await tool.execute({ code, ...(input !== undefined ? { input } : {}) })) as SandboxResult;
}

describe('sandboxedJsTool', () => {
  describe('evaluation', () => {
    it('returns the last expression value', async () => {
      const { result } = await run('const x = 6; x * 7');

      expect(result).toBe(42);
    });

    it('returns objects and arrays as JSON values', async () => {
      const { result } = await run('({ items: [1, 2, 3].map((n) => n * 2) })');

      expect(result).toEqual({ items: [2, 4, 6] });
    });

    it('exposes input as a global', async () => {
      const { result } = await run(
        'input.orders.reduce((acc, o) => acc + o.total, 0)',
        { orders: [{ total: 40 }, { total: 2 }] },
      );

      expect(result).toBe(42);
    });

    it('round-trips input without sharing references', async () => {
      const original = { nested: { value: 1 } };

      const { result } = await run('input.nested.value = 99; input', original);

      expect(result).toEqual({ nested: { value: 99 } });
      expect(original.nested.value).toBe(1);
    });

    it('captures console.log output in order, stringifying non-strings', async () => {
      const { logs } = await run('console.log("a"); console.log({ b: 1 }); console.log("c"); 0');

      expect(logs).toEqual(['a', '{"b":1}', 'c']);
    });

    it('returns null for an undefined completion value', async () => {
      const { result } = await run('const unused = 1;');

      expect(result).toBeNull();
    });
  });

  describe('failure modes', () => {
    it('surfaces syntax errors', async () => {
      await expect(run('const = broken')).rejects.toThrow(/Execution failed/);
    });

    it('surfaces runtime exceptions with their message', async () => {
      await expect(run('throw new Error("guest boom")')).rejects.toThrow(/guest boom/);
    });

    it('rejects Promise completion values', async () => {
      await expect(run('Promise.resolve(1)')).rejects.toThrow(/synchronous/);
    });

    it('rejects results that are not JSON-serializable', async () => {
      await expect(run('(() => 1)')).rejects.toThrow(/not JSON-serializable/);
    });
  });

  describe('limits', () => {
    it('interrupts an infinite loop at the deadline', async () => {
      const fast = sandboxedJsTool({ deadlineMs: 300 });

      await expect(fast.execute({ code: 'for(;;);' })).rejects.toThrow(/deadline|interrupted/);
    });

    it('errors at the memory limit on allocation bombs', async () => {
      const small = sandboxedJsTool({
        memoryLimitBytes: 4 * 1024 * 1024,
        deadlineMs: 2_000,
        terminateMarginMs: 1_000,
      });

      await expect(
        small.execute({ code: 'const a = []; for (;;) a.push(new Array(100000).fill(0));' }),
      ).rejects.toThrow();
    }, 15_000);

    it('rejects oversized code before spawning a worker', async () => {
      const capped = sandboxedJsTool({ maxCodeBytes: 10 });

      await expect(capped.execute({ code: '1 + 1 + 1 + 1' })).rejects.toThrow(/byte cap/);
    });

    it('rejects oversized input before spawning a worker', async () => {
      const capped = sandboxedJsTool({ maxInputBytes: 10 });

      await expect(
        capped.execute({ code: 'input', input: { big: 'x'.repeat(100) } }),
      ).rejects.toThrow(/byte cap/);
    });

    it('errors on results over the cap instead of truncating', async () => {
      const capped = sandboxedJsTool({ maxResultBytes: 100 });

      await expect(capped.execute({ code: '"x".repeat(1000)' })).rejects.toThrow(/exceeds the 100-byte cap/);
    });

    it('force-terminates via the worker backstop when the margin is exhausted', async () => {
      const noMargin = sandboxedJsTool({ deadlineMs: 1, terminateMarginMs: 0 });

      await expect(noMargin.execute({ code: '1 + 1' })).rejects.toThrow(/terminated/);
    });

    it('caps captured log entries', async () => {
      const capped = sandboxedJsTool({ maxLogEntries: 2 });

      const { logs } = (await capped.execute({
        code: 'for (let i = 0; i < 10; i++) console.log(String(i)); 0',
      })) as SandboxResult;

      expect(logs).toEqual(['0', '1']);
    });
  });

  describe('escape probes (security-review checklist)', () => {
    it.each([
      'require',
      'process',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'setTimeout',
      'setInterval',
      'SharedArrayBuffer',
      '__log_host_leak',
    ])('leaves %s undefined in the guest', async (name) => {
      const { result } = await run(`typeof ${name}`);

      expect(result).toBe('undefined');
    });

    it('has no module system: dynamic import fails', async () => {
      await expect(run('import("node:fs")')).rejects.toThrow();
    });

    it('rejects non-string arguments forced through the log bridge', async () => {
      await expect(run('__log(42)')).rejects.toThrow();
    });

    it('keeps eval inside the sandbox with the same limits', async () => {
      const { result } = await run('eval("typeof process")');

      expect(result).toBe('undefined');
    });
  });

  describe('GraphRunner integration', () => {
    it('executes inside a tool node with the result in memory', async () => {
      const graph = createGraph({
        name: 'sandbox-graph',
        description: 'tool node running sandboxed_js',
        nodes: [
          {
            id: 'compute',
            type: 'tool',
            toolId: 'sandboxed_js',
            tools: ['sandboxed_js'],
            readKeys: ['code'],
          },
        ],
        edges: [],
        startNode: 'compute',
        endNodes: ['compute'],
      });
      const state = createWorkflowState({
        workflowId: crypto.randomUUID(),
        goal: 'compute',
        memory: { code: '[1, 2, 3, 4].reduce((a, b) => a + b, 0)' },
      });
      const runner = new GraphRunner(graph, state, { tools: [sandboxedJsTool()] });

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      const nodeResult = finalState.memory.compute_result as SandboxResult;
      expect(nodeResult.result).toBe(10);
    });
  });
});

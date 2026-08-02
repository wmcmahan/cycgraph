import { describe, it, expect } from 'vitest';
import { runWithContext, getCurrentContext } from '../src/utils/context.js';

describe('RunContext (AsyncLocalStorage)', () => {
  it('returns empty object outside a context scope', () => {
    const ctx = getCurrentContext();
    expect(ctx).toEqual({});
  });

  it('provides context within runWithContext scope', async () => {
    const result = await runWithContext({ run_id: 'r1', graph_id: 'g1' }, async () => {
      return getCurrentContext();
    });
    expect(result.run_id).toBe('r1');
    expect(result.graph_id).toBe('g1');
  });

  it('isolates context across concurrent async operations', async () => {
    const results = await Promise.all([
      runWithContext({ run_id: 'run-a' }, async () => {
        await new Promise(r => setTimeout(r, 10));
        return getCurrentContext();
      }),
      runWithContext({ run_id: 'run-b' }, async () => {
        await new Promise(r => setTimeout(r, 5));
        return getCurrentContext();
      }),
    ]);

    expect(results[0].run_id).toBe('run-a');
    expect(results[1].run_id).toBe('run-b');
  });

  it('propagates through async call chains', async () => {
    async function innerFn(): Promise<string | undefined> {
      return getCurrentContext().run_id;
    }

    const result = await runWithContext({ run_id: 'propagated' }, async () => {
      return innerFn();
    });
    expect(result).toBe('propagated');
  });

  it('supports nested context scopes (inner overrides outer)', async () => {
    const result = await runWithContext({ run_id: 'outer', graph_id: 'g1' }, async () => {
      return runWithContext({ run_id: 'inner' }, async () => {
        return getCurrentContext();
      });
    });
    expect(result.run_id).toBe('inner');
    expect(result.graph_id).toBeUndefined();
  });

  it('returns empty context after scope exits', async () => {
    await runWithContext({ run_id: 'scoped' }, async () => {
    });
    const ctx = getCurrentContext();
    expect(ctx).toEqual({});
  });
});

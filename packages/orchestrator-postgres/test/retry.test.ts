/**
 * Unit tests for `retry.ts` — the transient-error retry helper used by the
 * version-increment race in `saveWorkflowState`. No live DB: the thrown error
 * shape produced by `node-postgres` is faked.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  retryOnTransient,
  isPostgresUniqueViolation,
  POSTGRES_UNIQUE_VIOLATION,
} from '../src/retry.js';

function uniqueViolation(message = 'duplicate key value violates unique constraint'): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = POSTGRES_UNIQUE_VIOLATION;
  return err;
}

describe('isPostgresUniqueViolation', () => {
  it('detects the 23505 SQLSTATE on shaped error objects', () => {
    expect(isPostgresUniqueViolation(uniqueViolation())).toBe(true);
  });

  it('returns false for a plain Error with no code', () => {
    expect(isPostgresUniqueViolation(new Error('boom'))).toBe(false);
  });

  it('returns false for null and non-object inputs', () => {
    expect(isPostgresUniqueViolation(null)).toBe(false);
    expect(isPostgresUniqueViolation('plain string')).toBe(false);
  });

  it('returns false for a different SQLSTATE code', () => {
    const other = new Error('connection refused') as Error & { code: string };
    other.code = 'ECONNREFUSED';

    expect(isPostgresUniqueViolation(other)).toBe(false);
  });
});

describe('retryOnTransient', () => {
  it('returns the value on first success without retries', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(retryOnTransient(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries unique-violation errors and eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce('eventually');

    const result = await retryOnTransient(fn, { max_retries: 5, base_delay_ms: 1, max_delay_ms: 2 });

    expect(result).toBe('eventually');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-transient errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not transient'));

    await expect(retryOnTransient(fn, { max_retries: 5, base_delay_ms: 1 })).rejects.toThrow('not transient');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting retries', async () => {
    const INITIAL_PLUS_RETRIES = 4;
    const fn = vi.fn().mockRejectedValue(uniqueViolation('persistent race'));

    await expect(retryOnTransient(fn, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 2 }))
      .rejects.toMatchObject({ code: POSTGRES_UNIQUE_VIOLATION, message: 'persistent race' });
    expect(fn).toHaveBeenCalledTimes(INITIAL_PLUS_RETRIES);
  });

  it('invokes on_retry with attempt count and error for each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce('ok');

    await retryOnTransient(fn, { max_retries: 3, base_delay_ms: 1, max_delay_ms: 2, on_retry: onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, err, delay] = onRetry.mock.calls[0];
    expect(attempt).toBe(1);
    expect((err as { code: string }).code).toBe(POSTGRES_UNIQUE_VIOLATION);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it('respects a custom is_transient predicate', async () => {
    const serializationFailure = Object.assign(new Error('serialization failure'), { code: '40001' });
    const fn = vi.fn()
      .mockRejectedValueOnce(serializationFailure)
      .mockResolvedValueOnce('ok');

    await expect(retryOnTransient(fn, {
      base_delay_ms: 1,
      max_delay_ms: 2,
      is_transient: (e) => (e as { code?: string }).code === '40001',
    })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

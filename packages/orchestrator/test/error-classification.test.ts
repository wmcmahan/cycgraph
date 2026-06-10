/**
 * error-classification.test.ts — classifyRetryable
 */
import { describe, test, expect } from 'vitest';
import { APICallError } from 'ai';
import { classifyRetryable } from '../src/agent/agent-executor/error-classification.js';

function apiError(statusCode: number, isRetryable: boolean): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

describe('classifyRetryable', () => {
  test('honors APICallError.isRetryable === false (e.g. 400)', () => {
    expect(classifyRetryable(apiError(400, false))).toBe(false);
  });

  test('honors APICallError.isRetryable === true (e.g. 429)', () => {
    expect(classifyRetryable(apiError(429, true))).toBe(true);
  });

  test('unwraps a wrapped APICallError on .cause', () => {
    const wrapper = new Error('agent failed') as Error & { cause?: unknown };
    wrapper.cause = apiError(400, false);
    expect(classifyRetryable(wrapper)).toBe(false);
  });

  test('returns undefined for unknown errors (default → retry)', () => {
    expect(classifyRetryable(new Error('network blip'))).toBeUndefined();
    expect(classifyRetryable('not even an error')).toBeUndefined();
  });
});

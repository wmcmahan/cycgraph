/**
 * error-classification.test.ts — classifyRetryable and describeError
 */
import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { classifyRetryable, describeError } from '../src/agents/executors/agent/error-classification.js';

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
  it('honors APICallError.isRetryable === false (e.g. 400)', () => {
    expect(classifyRetryable(apiError(400, false))).toBe(false);
  });

  it('honors APICallError.isRetryable === true (e.g. 429)', () => {
    expect(classifyRetryable(apiError(429, true))).toBe(true);
  });

  it('unwraps a wrapped APICallError on .cause', () => {
    const wrapper = new Error('agent failed') as Error & { cause?: unknown };
    wrapper.cause = apiError(400, false);
    expect(classifyRetryable(wrapper)).toBe(false);
  });

  it('retries a response that arrived with a 2xx status but could not be read', () => {
    const unreadable = new APICallError({
      message: 'Failed to process successful response',
      url: 'https://api.example.com',
      requestBodyValues: {},
      statusCode: 200,
      cause: new Error('Empty response body'),
    });

    expect(unreadable.isRetryable).toBe(false);
    expect(classifyRetryable(unreadable)).toBe(true);
  });

  it('returns undefined for unknown errors (default → retry)', () => {
    expect(classifyRetryable(new Error('network blip'))).toBeUndefined();
    expect(classifyRetryable('not even an error')).toBeUndefined();
  });
});

describe('describeError', () => {
  it('reports the cause chain, status, request id, and response body of a provider error', () => {
    const root = new Error('Empty response body');
    root.name = 'AI_EmptyResponseBodyError';
    const error = new APICallError({
      message: 'Failed to process successful response',
      url: 'https://api.example.com',
      requestBodyValues: {},
      statusCode: 200,
      responseHeaders: { 'request-id': 'req_123' },
      responseBody: 'x'.repeat(1_500),
      cause: root,
    });

    const fields = describeError(error);

    expect(fields).toEqual({
      error_name: 'AI_APICallError',
      error_message: 'Failed to process successful response',
      error_causes: ['AI_EmptyResponseBodyError: Empty response body'],
      status_code: 200,
      provider_retryable: false,
      provider_request_id: 'req_123',
      response_body: 'x'.repeat(1_000),
    });
  });

  it('reads the provider error under a wrapping error', () => {
    const wrapper = new Error('Agent auditor execution failed', { cause: apiError(529, true) });

    expect(describeError(wrapper)).toMatchObject({ status_code: 529, provider_retryable: true, error_causes: ['AI_APICallError: HTTP 529'] });
  });

  it('describes a non-error value without throwing', () => {
    expect(describeError('boom')).toEqual({ error_name: 'string', error_message: 'boom' });
  });
});

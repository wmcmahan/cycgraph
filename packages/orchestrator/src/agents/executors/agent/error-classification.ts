/**
 * LLM error classification.
 *
 * @module agents/executors/agent/error-classification
 */

import { APICallError } from 'ai';

/**
 * Classify whether an LLM call error is worth retrying.
 *
 * The Vercel AI SDK surfaces provider errors as `APICallError` carrying an
 * `isRetryable` flag the provider sets per status code (429 / 5xx / 529 →
 * retryable; 400 invalid-request, context-length-exceeded, 401 / 403 / 404 →
 * not). We honor that flag, checking a wrapped `cause` too, with one
 * exception: an error with a 2xx status is always retryable. The provider
 * answered but the response could not be read, such as an empty body, and
 * the SDK marks that non-retryable by status alone although a fresh
 * request can succeed.
 *
 * Returns `undefined` for unknown errors so the retry loop keeps its default
 * (retry) — we only SHORT-CIRCUIT on a definite non-retryable signal, never
 * suppress a retry we're unsure about.
 */
export function classifyRetryable(error: unknown): boolean | undefined {
  const apiError = APICallError.isInstance(error)
    ? error
    : APICallError.isInstance((error as { cause?: unknown })?.cause) ? (error as { cause: APICallError }).cause : undefined;
  if (apiError === undefined) return undefined;
  if (apiError.statusCode !== undefined && apiError.statusCode >= 200 && apiError.statusCode < 300) return true;
  return apiError.isRetryable;
}

/** Most nested causes {@link describeError} reports. */
const MAX_CAUSE_DEPTH = 4;
/** Longest provider response body {@link describeError} reports. */
const MAX_RESPONSE_BODY_CHARS = 1_000;
/** Response headers that identify a request to the provider's support. */
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'anthropic-request-id', 'openai-request-id'];

/** The provider detail fields an `APICallError` carries. */
interface ProviderErrorFields {
  statusCode?: number;
  isRetryable: boolean;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

/**
 * Whether a value carries `APICallError`'s provider fields. Read by shape
 * rather than class so describing an error can never itself throw.
 */
function isProviderError(value: unknown): value is ProviderErrorFields {
  return typeof value === 'object' && value !== null && typeof (value as { isRetryable?: unknown }).isRetryable === 'boolean';
}

/**
 * Log fields describing an LLM call failure: the error's name, its chain
 * of causes, and the provider detail an `APICallError` carries (status,
 * retryability, request id, and a truncated response body). The wrapper
 * the SDK throws often says only "Failed to process successful response";
 * the cause underneath is what identifies the fault.
 */
export function describeError(error: unknown): Record<string, unknown> {
  const causes: string[] = [];
  let current = (error as { cause?: unknown })?.cause;
  for (let depth = 0; current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH; depth++) {
    causes.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = (current as { cause?: unknown })?.cause;
  }
  const apiError = [error, (error as { cause?: unknown })?.cause].find(isProviderError);
  const requestId = REQUEST_ID_HEADERS
    .map((header) => apiError?.responseHeaders?.[header])
    .find((value) => value !== undefined);
  return {
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
    ...(causes.length > 0 ? { error_causes: causes } : {}),
    ...(apiError?.statusCode !== undefined ? { status_code: apiError.statusCode } : {}),
    ...(apiError !== undefined ? { provider_retryable: apiError.isRetryable } : {}),
    ...(requestId !== undefined ? { provider_request_id: requestId } : {}),
    ...(apiError?.responseBody !== undefined ? { response_body: apiError.responseBody.slice(0, MAX_RESPONSE_BODY_CHARS) } : {}),
  };
}

/**
 * OpenTelemetry Tracing for @cycgraph/orchestrator
 *
 * Opt-in distributed tracing via OTLP HTTP exporter.
 * Traces are sent to Jaeger (or any OTel-compatible backend).
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, all tracing is a no-op.
 * This ensures zero impact on tests and local dev without Docker.
 *
 * @example
 * ```ts
 * import { initTracing, getTracer, withSpan } from './observability/tracing.js';
 *
 * await initTracing('orchestrator');
 * const tracer = getTracer('runner.graph');
 * await withSpan(tracer, 'workflow.run', async (span) => { ... });
 * ```
 *
 * @module observability/tracing
 */

import { trace, propagation, context, type Tracer, type Span, SpanStatusCode } from '@opentelemetry/api';
import { initMetrics } from './metrics.js';

let initialized = false;

/**
 * Initialize OpenTelemetry tracing and metrics.
 *
 * Must be called **once** at application startup, before any traced
 * code runs. No-ops gracefully if `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * not set. Metrics are independently gated by `METRICS_ENABLED=true`.
 *
 * Safe to call multiple times (idempotent).
 *
 * @param serviceName - Name that appears in Jaeger (e.g. `"orchestrator"`).
 */
export async function initTracing(serviceName: string): Promise<void> {
  if (initialized) return;

  // Always init metrics (it no-ops internally when METRICS_ENABLED != 'true')
  await initMetrics();

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    initialized = true;
    return; // No-op: tracing disabled
  }

  // Dynamic imports to avoid loading OTel machinery when tracing is disabled
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: exporter,
  });

  sdk.start();
  initialized = true;

  // Graceful shutdown on process signals
  const shutdown = async () => {
    await sdk.shutdown();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Get a named tracer instance.
 *
 * Returns a no-op tracer if OTel is not initialized, so callers
 * never need to check whether tracing is enabled.
 *
 * @param name - Tracer name (e.g. `"runner.graph"`, `"agent.executor"`).
 * @returns A {@link Tracer} instance.
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/**
 * Execute an async function within a new span.
 *
 * Automatically:
 * - Creates a child span under the current context
 * - Sets span status to `OK` on success
 * - Sets span status to `ERROR` and records the exception on failure
 * - Ends the span in all cases (via `finally`)
 *
 * @param tracer - Tracer to create the span with.
 * @param name - Span name (e.g. `"workflow.run"`, `"node.execute"`).
 * @param fn - Async function to execute within the span.
 * @param attributes - Optional initial span attributes.
 * @returns The return value of `fn`.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

// Re-export for convenience
export { SpanStatusCode, type Span } from '@opentelemetry/api';
export { context };

/**
 * Inject the active trace context into outbound request headers as W3C
 * `traceparent` / `tracestate`.
 *
 * This is what makes a call to another system appear in the SAME trace as
 * the run that made it, rather than as two unrelated traces nobody can
 * correlate. Without it, "where did the time go" stops at our own boundary.
 *
 * A no-op when tracing is not configured, so callers can inject
 * unconditionally.
 *
 * Note that this DISCLOSES the trace id to the receiver. That is normal for
 * distributed tracing inside one system, and a deliberate choice across an
 * organisational boundary — callers should gate it per destination rather
 * than assume it everywhere.
 */
export function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { ...headers, ...carrier };
}

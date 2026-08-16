/**
 * OpenTelemetry Metrics for @cycgraph/orchestrator
 *
 * Opt-in Prometheus metrics via the OTel SDK.
 * Enabled when `METRICS_ENABLED=true`.
 *
 * When disabled, all recording functions are zero-cost no-ops
 * (they check `undefined` instruments and return immediately).
 *
 * @module observability/metrics
 */

import type { Counter, Histogram, ObservableGauge, BatchObservableResult } from '@opentelemetry/api';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';

// ─── State ──────────────────────────────────────────────────────────

let meterProvider: MeterProvider | undefined;

/** Exported for the `server.ts` `/metrics` endpoint. */
export let prometheusExporter: import('@opentelemetry/exporter-prometheus').PrometheusExporter | undefined;

// Instruments (populated once on init)
let workflowRuns: Counter | undefined;
let tokensUsed: Counter | undefined;
let costUsd: Counter | undefined;
let workflowDuration: Histogram | undefined;
let agentDuration: Histogram | undefined;
let queueDepthGauge: ObservableGauge | undefined;

/** Queue depth provider callback (set by the API layer). */
let queueDepthFn: (() => Promise<number>) | undefined;

let initialized = false;

// ─── Initialization ─────────────────────────────────────────────────

/**
 * Initialize metrics.
 *
 * Must be called before any recording. No-ops if `METRICS_ENABLED`
 * is not `'true'`. Safe to call multiple times (idempotent).
 */
export async function initMetrics(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (process.env.METRICS_ENABLED !== 'true') return;

  const { MeterProvider } = await import('@opentelemetry/sdk-metrics');
  const { PrometheusExporter } = await import('@opentelemetry/exporter-prometheus');

  prometheusExporter = new PrometheusExporter({ preventServerStart: true });
  meterProvider = new MeterProvider({ readers: [prometheusExporter] });

  const meter = meterProvider.getMeter('@cycgraph/orchestrator', '1.0.0');

  // One counter with a status dimension rather than three names that differ by
  // one word. `started` counts every run and `completed`/`failed` partition the
  // terminal ones, so the statuses are phases and must not be summed together.
  workflowRuns = meter.createCounter('workflow.runs', {
    description: 'Workflow runs, by lifecycle status',
    unit: '{run}',
  });

  tokensUsed = meter.createCounter('workflow.tokens', {
    description: 'LLM tokens consumed, totalled per run',
    unit: '{token}',
  });

  costUsd = meter.createCounter('workflow.cost', {
    description: 'Estimated LLM cost, totalled per run',
    unit: '{USD}',
  });

  workflowDuration = meter.createHistogram('workflow.run.duration', {
    description: 'Workflow execution duration',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 5, 30] },
  });

  // OpenTelemetry's GenAI semantic convention, which this measurement already
  // matches: one observation per model call. Experimental upstream, so expect
  // it to move.
  agentDuration = meter.createHistogram('gen_ai.client.operation.duration', {
    description: 'Model call duration',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 5] },
  });

  queueDepthGauge = meter.createObservableGauge('workflow.queue.depth', {
    description: 'Jobs in the workflow queue, waiting plus active',
    unit: '{job}',
  });

  meter.addBatchObservableCallback(
    async (observableResult: BatchObservableResult) => {
      if (queueDepthFn && queueDepthGauge) {
        try {
          const depth = await queueDepthFn();
          observableResult.observe(queueDepthGauge, depth);
        } catch {
          // Best effort — don't crash on queue depth failures
        }
      }
    },
    [queueDepthGauge],
  );
}

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Register the source the queue-depth gauge reads at scrape time.
 *
 * `WorkflowWorker` registers its own queue on start and clears it on stop.
 * Pass `undefined` to unregister, which stops further observation. The
 * Prometheus exporter keeps serving the last value it saw, so a scrape after
 * shutdown still reports the depth at the moment the worker stopped.
 *
 * @param fn - Async function returning the current depth, or `undefined`.
 */
export function setQueueDepthProvider(fn: (() => Promise<number>) | undefined): void {
  queueDepthFn = fn;
}

// ─── Recording Functions ────────────────────────────────────────────
// All are no-ops when metrics are disabled (instruments are undefined).

/** Record a workflow start event. */
export function incrementWorkflowsStarted(labels?: Record<string, string>): void {
  workflowRuns?.add(1, { ...labels, status: 'started' });
}

/** Record a workflow completion event. */
export function incrementWorkflowsCompleted(labels?: Record<string, string>): void {
  workflowRuns?.add(1, { ...labels, status: 'completed' });
}

/** Record a workflow failure event. */
export function incrementWorkflowsFailed(labels?: Record<string, string>): void {
  workflowRuns?.add(1, { ...labels, status: 'failed' });
}

/** Record LLM token consumption. */
export function recordTokensUsed(count: number, labels?: Record<string, string>): void {
  tokensUsed?.add(count, labels);
}

/** Record LLM cost in USD. */
export function recordCostUsd(amount: number, labels?: Record<string, string>): void {
  costUsd?.add(amount, labels);
}

/** Record workflow execution duration. Takes milliseconds, records seconds. */
export function recordWorkflowDuration(durationMs: number, labels?: Record<string, string>): void {
  workflowDuration?.record(durationMs / 1000, labels);
}

/** Record one model call's duration. Takes milliseconds, records seconds. */
export function recordAgentDuration(durationMs: number, labels?: Record<string, string>): void {
  agentDuration?.record(durationMs / 1000, labels);
}

// ─── Prometheus Scraping ────────────────────────────────────────────

/**
 * Collect current Prometheus metrics for scraping.
 *
 * Returns `null` when metrics are disabled.
 *
 * @returns Object with `contentType` and serialized `metrics`, or `null`.
 */
export async function collectMetrics(): Promise<{ contentType: string; metrics: string } | null> {
  if (!prometheusExporter) return null;
  const { PrometheusSerializer } = await import('@opentelemetry/exporter-prometheus');
  const result = await prometheusExporter.collect();
  const serializer = new PrometheusSerializer();
  return {
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
    metrics: serializer.serialize(result.resourceMetrics),
  };
}

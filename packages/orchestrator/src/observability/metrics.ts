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
let workflowsStarted: Counter | undefined;
let workflowsCompleted: Counter | undefined;
let workflowsFailed: Counter | undefined;
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

  workflowsStarted = meter.createCounter('mcai_workflows_started_total', {
    description: 'Total number of workflows started',
    unit: 'workflows',
  });

  workflowsCompleted = meter.createCounter('mcai_workflows_completed_total', {
    description: 'Total number of workflows completed successfully',
    unit: 'workflows',
  });

  workflowsFailed = meter.createCounter('mcai_workflows_failed_total', {
    description: 'Total number of workflows that failed',
    unit: 'workflows',
  });

  tokensUsed = meter.createCounter('mcai_tokens_used_total', {
    description: 'Total LLM tokens consumed across all workflows',
    unit: 'tokens',
  });

  costUsd = meter.createCounter('mcai_cost_usd_total', {
    description: 'Total LLM cost in USD across all workflows',
    unit: 'usd',
  });

  workflowDuration = meter.createHistogram('mcai_workflow_duration_ms', {
    description: 'Workflow execution duration in milliseconds',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [100, 500, 1000, 5000, 30000] },
  });

  agentDuration = meter.createHistogram('mcai_agent_duration_ms', {
    description: 'Agent node execution duration in milliseconds',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [100, 500, 1000, 5000] },
  });

  queueDepthGauge = meter.createObservableGauge('mcai_queue_depth', {
    description: 'Current number of jobs in the workflow queue (waiting + active)',
    unit: '1',
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
 * Register a callback that returns the current queue depth.
 *
 * Called from the API layer where queue access is available.
 *
 * @param fn - Async function returning the current queue depth.
 */
export function setQueueDepthProvider(fn: () => Promise<number>): void {
  queueDepthFn = fn;
}

// ─── Recording Functions ────────────────────────────────────────────
// All are no-ops when metrics are disabled (instruments are undefined).

/** Record a workflow start event. */
export function incrementWorkflowsStarted(labels?: Record<string, string>): void {
  workflowsStarted?.add(1, labels);
}

/** Record a workflow completion event. */
export function incrementWorkflowsCompleted(labels?: Record<string, string>): void {
  workflowsCompleted?.add(1, labels);
}

/** Record a workflow failure event. */
export function incrementWorkflowsFailed(labels?: Record<string, string>): void {
  workflowsFailed?.add(1, labels);
}

/** Record LLM token consumption. */
export function recordTokensUsed(count: number, labels?: Record<string, string>): void {
  tokensUsed?.add(count, labels);
}

/** Record LLM cost in USD. */
export function recordCostUsd(amount: number, labels?: Record<string, string>): void {
  costUsd?.add(amount, labels);
}

/** Record workflow execution duration. */
export function recordWorkflowDuration(durationMs: number, labels?: Record<string, string>): void {
  workflowDuration?.record(durationMs, labels);
}

/** Record agent node execution duration. */
export function recordAgentDuration(durationMs: number, labels?: Record<string, string>): void {
  agentDuration?.record(durationMs, labels);
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

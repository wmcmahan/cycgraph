/**
 * Tests for observability/metrics: the disabled no-op path and the enabled
 * Prometheus path (real OTel SDK), exercised by re-importing the module
 * with METRICS_ENABLED controlled per test.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

type MetricsModule = typeof import('../src/observability/metrics.js');

async function loadMetrics(enabled: boolean): Promise<MetricsModule> {
  vi.resetModules();
  if (enabled) process.env.METRICS_ENABLED = 'true';
  else delete process.env.METRICS_ENABLED;
  return import('../src/observability/metrics.js');
}

describe('metrics (disabled)', () => {
  afterEach(() => {
    delete process.env.METRICS_ENABLED;
    vi.resetModules();
  });

  it('initMetrics no-ops when METRICS_ENABLED is not true', async () => {
    const m = await loadMetrics(false);

    await m.initMetrics();

    expect(await m.collectMetrics()).toBeNull();
  });

  it('recording functions do not throw when metrics are disabled', async () => {
    const m = await loadMetrics(false);

    expect(() => m.incrementWorkflowsStarted({ graph_id: 'g1' })).not.toThrow();
    expect(() => m.incrementWorkflowsCompleted()).not.toThrow();
    expect(() => m.incrementWorkflowsFailed()).not.toThrow();
    expect(() => m.recordWorkflowDuration(1234)).not.toThrow();
    expect(() => m.recordAgentDuration(100, { graph_id: 'g1' })).not.toThrow();
    expect(() => m.recordTokensUsed(500, { model: 'gpt-4o' })).not.toThrow();
    expect(() => m.recordCostUsd(0.05)).not.toThrow();
  });

  it('setQueueDepthProvider accepts a callback without error', async () => {
    const m = await loadMetrics(false);

    expect(() => m.setQueueDepthProvider(async () => 5)).not.toThrow();
  });
});

describe('metrics (enabled)', () => {
  afterEach(() => {
    delete process.env.METRICS_ENABLED;
    vi.resetModules();
  });

  it('initializes Prometheus instruments and serializes recorded metrics', async () => {
    const m = await loadMetrics(true);

    await m.initMetrics();
    m.incrementWorkflowsStarted({ graph_id: 'g1' });
    m.recordTokensUsed(500, { model: 'gpt-4o' });

    const collected = await m.collectMetrics();

    expect(collected).not.toBeNull();
    expect(collected!.contentType).toContain('text/plain');
    expect(collected!.metrics).toContain('mcai_workflows_started_total');
    expect(collected!.metrics).toContain('mcai_tokens_used_total');
  });

  it('is idempotent — a second initMetrics call does not re-create instruments', async () => {
    const m = await loadMetrics(true);

    await m.initMetrics();
    await m.initMetrics();

    expect(await m.collectMetrics()).not.toBeNull();
  });

  it('observes queue depth from a registered provider during collection', async () => {
    const m = await loadMetrics(true);
    await m.initMetrics();

    m.setQueueDepthProvider(async () => 7);
    const collected = await m.collectMetrics();

    expect(collected!.metrics).toContain('mcai_queue_depth');
    expect(collected!.metrics).toContain('7');
  });

  it('swallows errors thrown by the queue depth provider', async () => {
    const m = await loadMetrics(true);
    await m.initMetrics();

    m.setQueueDepthProvider(async () => {
      throw new Error('queue unavailable');
    });

    await expect(m.collectMetrics()).resolves.not.toBeNull();
  });
});

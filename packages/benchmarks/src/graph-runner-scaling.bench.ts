/**
 * GraphRunner Scaling
 *
 * End-to-end run() throughput as a function of graph size. Uses tool nodes
 * with the built-in `save_to_memory` so there's no LLM in the loop — what
 * we're measuring is the runner overhead: routing, reducer dispatch, event
 * log writes, idempotency tracking, executor context construction.
 *
 * Hypothesis baseline:
 *   - 10-node graph: sub-millisecond per node
 *   - 100-node graph: linear scaling, no obvious cliffs
 *   - 1000-node graph: completes within a reasonable time budget
 *
 * Compare run() against stream() to quantify the streaming-mode overhead.
 *
 * Run: `npm run bench --workspace=packages/benchmarks`
 */

import { bench, describe } from 'vitest';
import { GraphRunner, isTerminalEvent } from '@cycgraph/orchestrator';
import { buildLinearToolGraph, buildBenchState } from './helpers.js';

describe('GraphRunner.run() — graph size scaling', () => {
  const graph10 = buildLinearToolGraph(10);
  const graph100 = buildLinearToolGraph(100);
  const graph1000 = buildLinearToolGraph(1000);

  bench('10-node linear', async () => {
    const runner = new GraphRunner(graph10, buildBenchState(graph10));
    await runner.run();
  });

  bench('100-node linear', async () => {
    const runner = new GraphRunner(graph100, buildBenchState(graph100));
    await runner.run();
  });

  bench('1000-node linear', async () => {
    const runner = new GraphRunner(graph1000, buildBenchState(graph1000, { maxIterations: 1500 }));
    await runner.run();
  }, { iterations: 5 }); // expensive — fewer iterations
});

describe('GraphRunner.stream() — streaming mode overhead', () => {
  const graph100 = buildLinearToolGraph(100);

  bench('100-node run()', async () => {
    const runner = new GraphRunner(graph100, buildBenchState(graph100));
    await runner.run();
  });

  bench('100-node stream() consumed to completion', async () => {
    const runner = new GraphRunner(graph100, buildBenchState(graph100));
    for await (const event of runner.stream()) {
      // Drain — the consumer doesn't actually do anything, but the runner
      // still has to maintain the channel + tokenChannel + notify slot.
      if (isTerminalEvent(event)) break;
    }
  });
});

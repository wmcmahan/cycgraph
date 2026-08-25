/**
 * Tests for the self-improvement loop (src/improve/loop.ts): how far each
 * autonomy climbs, and that its budgets actually stop it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { graph, node, tool } from '@cycgraph/orchestrator';
import { runImproveLoop } from '../src/improve/loop.js';
import { listProposals } from '../src/improve/proposals.js';
import { scenario } from '../src/scenarios/types.js';
import { defaultStackConfig, type Stack } from '../src/stack/index.js';
import { InMemoryEventLogWriter, InMemoryPersistenceProvider } from '@cycgraph/orchestrator';

let root: string;

const counter = scenario({
  id: 'counter',
  title: 'Counter',
  covers: [],
  requires: [],
  params: z.object({}),
  build: async () => {
    const tick = tool({
      name: 'tick',
      description: 'Ticks.',
      parameters: z.object({}),
      execute: () => ({ ticked: true }),
    });
    return {
      graph: graph({
        name: 'counter',
        nodes: [node({ id: 'tick', type: 'tool', toolId: 'tick', tools: [tick] })],
      }),
      input: { goal: 'Tick once.' },
      runner: {},
    };
  },
  evals: () => [{ type: 'status_equals', expected: 'completed' }],
});

function stackAt(root: string): Stack {
  return {
    config: { ...defaultStackConfig(), artifactRoot: root, postgres: false, jaeger: false, servers: false, memory: false },
    available: new Set(),
    gaps: [],
    persistence: new InMemoryPersistenceProvider(),
    eventLog: new InMemoryEventLogWriter(),
    close: async () => {},
  };
}

async function seedProposal(status: string): Promise<void> {
  const dir = join(root, 'proposals');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'seeded.json'), JSON.stringify({
    id: 'seeded',
    workflow: 'counter',
    nodeId: 'tick',
    knob: 'max_iterations',
    from: 8,
    to: 4,
    change: [{ kind: 'config', node_id: 'tick', patch: { max_iterations: 4 } }],
    computeDelta: 0.5,
    tokenDelta: 0.5,
    model: 'test',
    status,
    statusChangedAt: new Date().toISOString(),
    measuredOn: [],
    createdAt: new Date().toISOString(),
  }, null, 2));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-loop-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runImproveLoop', () => {
  it('runs the workflow itself until the corpus can be measured', async () => {
    const result = await runImproveLoop(stackAt(root), counter, { maxRuns: 3, autonomy: 'propose' });

    expect(result.runs).toBe(3);
    expect(result.stoppedBecause).toBe('run budget spent');
    expect(result.events.filter((event) => event.kind === 'run')).toHaveLength(3);
  });

  it('stops at a proposal when autonomy is propose', async () => {
    await seedProposal('proposed');

    const result = await runImproveLoop(stackAt(root), counter, { autonomy: 'propose', maxRuns: 2 });

    expect(result.stoppedBecause).toBe('seeded is proposed and waiting for review');
    expect(result.runs).toBe(0);
  });

  it('promotes a proposal to trial when autonomy allows it, then stops', async () => {
    await seedProposal('proposed');

    const result = await runImproveLoop(stackAt(root), counter, { autonomy: 'trial', maxRuns: 2 });

    expect(result.stoppedBecause).toBe('seeded is on trial and waiting for review');
    const [record] = await listProposals(root, 'counter');
    expect(record!.status).toBe('trial');
  });

  it('stops when a measurement is declined rather than growing the corpus', async () => {
    // The counter workflow exposes no knobs, so the pass declines; the loop
    // must report that instead of running more of the same.
    const result = await runImproveLoop(stackAt(root), counter, { maxRuns: 12, autonomy: 'propose' });

    expect(result.runs).toBe(5);
    expect(result.measures).toBe(1);
    expect(result.stoppedBecause).toMatch(/motivates a knob|declined|skipped|no /i);
  });

  it('reports a refused apply instead of crashing, leaving the proposal on trial', async () => {
    await seedProposal('trial');

    const result = await runImproveLoop(stackAt(root), counter, {
      autonomy: 'apply', maxRuns: 4, trialRuns: 0, repoRoot: root,
    });

    expect(result.applyError).toBeDefined();
    expect(result.stoppedBecause).toMatch(/could not write seeded into source/);
    const [record] = await listProposals(root, 'counter');
    expect(record!.status).toBe('trial');
  });

  it('honours an abort signal', async () => {
    const aborter = new AbortController();
    aborter.abort();

    const result = await runImproveLoop(stackAt(root), counter, { signal: aborter.signal });

    expect(result).toMatchObject({ runs: 0, stoppedBecause: 'stopped by request' });
  });

  it('refuses a workflow whose stack requirements are unmet', async () => {
    const needsModel = scenario({ ...counter, id: 'needs-model', requires: ['model'] });

    const result = await runImproveLoop(stackAt(root), needsModel, { maxRuns: 1 });

    expect(result.stoppedBecause).toBe('needs-model needs model');
  });
});

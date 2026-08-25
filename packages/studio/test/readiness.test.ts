/**
 * Tests for workflowReadiness (src/improve/watch.ts): the gates the
 * dashboard shows before a tick reports them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { workflowReadiness } from '../src/improve/watch.js';
import { scenario } from '../src/scenarios/types.js';
import { defaultStackConfig, type Stack } from '../src/stack/index.js';

let root: string;

const flow = scenario({
  id: 'flow',
  title: 'Flow',
  covers: [],
  requires: [],
  params: z.object({}),
  build: async () => { throw new Error('never built here'); },
});

const modelFlow = scenario({
  id: 'model-flow',
  title: 'Model flow',
  covers: [],
  requires: ['model'],
  params: z.object({}),
  build: async () => { throw new Error('never built here'); },
});

function stackFor(root: string, available: string[] = []): Stack {
  return {
    config: { ...defaultStackConfig(), artifactRoot: root },
    available: new Set(available as never),
    gaps: [],
    persistence: undefined as never,
    eventLog: undefined as never,
    close: async () => {},
  };
}

async function recordRun(workflow: string, runId: string, startedAt: string, parentRunId?: string): Promise<void> {
  const dir = join(root, 'runs', `${workflow}-${runId}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    runId, scenarioId: workflow, params: {}, stack: {}, startedAt, status: 'completed',
    ...(parentRunId ? { parentRunId } : {}),
  }));
  await writeFile(join(dir, 'usage.json'), JSON.stringify({ totalTokens: 0, totalCostUsd: 0, nodesVisited: 1 }));
  await writeFile(join(dir, 'evals.json'), '[]');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-ready-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workflowReadiness', () => {
  it('counts fresh runs against the measuring floor', async () => {
    await recordRun('flow', 'a', '2026-08-20T00:00:01.000Z');
    await recordRun('flow', 'b', '2026-08-20T00:00:02.000Z');

    const [entry] = await workflowReadiness(stackFor(root), [flow]);

    expect(entry).toMatchObject({ freshRuns: 2, floor: 5, ready: false });
    expect(entry!.detail).toBe('3 more run(s) to measure');
  });

  it('is ready once the floor is met', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await recordRun('flow', id, `2026-08-20T00:00:0${id.charCodeAt(0) - 96}.000Z`);
    }

    const [entry] = await workflowReadiness(stackFor(root), [flow]);

    expect(entry).toMatchObject({ ready: true, detail: 'ready to measure' });
  });

  it('excludes forks from the corpus count', async () => {
    await recordRun('flow', 'a', '2026-08-20T00:00:01.000Z');
    await recordRun('flow', 'b', '2026-08-20T00:00:02.000Z', 'a');

    const [entry] = await workflowReadiness(stackFor(root), [flow]);

    expect(entry!.freshRuns).toBe(1);
  });

  it('reports the stack features a workflow is missing', async () => {
    const [entry] = await workflowReadiness(stackFor(root), [modelFlow]);

    expect(entry).toMatchObject({ ready: false, missing: ['model'], detail: 'needs model' });
  });
});

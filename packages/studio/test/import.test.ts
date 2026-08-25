/**
 * Tests for the external-run importer (src/run/import.ts): reconstruction
 * from the event log, idempotence, and the sensing layer seeing the result.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { graph, node, runRecorded, subgraph, tool, type RecordedRun } from '@cycgraph/orchestrator';
import { importAll, importRun } from '../src/run/import.js';
import { loadHistory, loadNodeTiming } from '../src/run/history.js';
import { profileWorkflow } from '../src/run/insights.js';
import { defaultStackConfig, type Stack } from '../src/stack/index.js';

let root: string;
let recorded: RecordedRun;

function externalGraph() {
  const echo = tool({
    name: 'echo',
    description: 'Echoes.',
    parameters: z.object({}),
    execute: () => ({ said: 'hi' }),
  });
  return graph({
    name: 'External Billing Flow',
    nodes: [node({ id: 'say', type: 'tool', toolId: 'echo', tools: [echo] })],
  });
}

function stackOver(run: RecordedRun): Stack {
  return {
    config: { ...defaultStackConfig(), artifactRoot: root },
    available: new Set(),
    gaps: [],
    persistence: run.persistence,
    eventLog: run.eventLog,
    close: async () => {},
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-import-'));
  recorded = await runRecorded(externalGraph(), { goal: 'An external run.' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('importRun', () => {
  it('reconstructs meta, usage, and node timings under the graph-name workflow', async () => {
    const outcome = await importRun(stackOver(recorded), recorded.runId);

    expect(outcome.imported).toBe(true);
    expect(outcome.workflow).toBe('external-billing-flow');

    const meta = JSON.parse(await readFile(join(outcome.dir!, 'meta.json'), 'utf8')) as {
      scenarioId: string; status: string; imported: boolean;
    };
    expect(meta.scenarioId).toBe('external-billing-flow');
    expect(meta.status).toBe('completed');
    expect(meta.imported).toBe(true);

    const timing = await loadNodeTiming(outcome.dir!);
    expect(timing['say']?.visits).toBe(1);
    expect(timing['say']?.type).toBe('tool');
  });

  it('appears in history and the workflow profile after import', async () => {
    const stack = stackOver(recorded);
    await importRun(stack, recorded.runId);

    const entries = await loadHistory(root, { scenarioId: 'external-billing-flow' });
    const profile = await profileWorkflow(root, 'external-billing-flow');

    expect(entries).toHaveLength(1);
    expect(profile?.nodes.map((n) => n.nodeId)).toContain('say');
  });

  it('refuses a second import of the same run', async () => {
    const stack = stackOver(recorded);
    await importRun(stack, recorded.runId);

    const again = await importRun(stack, recorded.runId);

    expect(again.imported).toBe(false);
    expect(again.reason).toBe('already in the artifact tree');
  });

  it('says plainly when persistence does not hold the run', async () => {
    const outcome = await importRun(stackOver(recorded), 'missing-run');

    expect(outcome).toEqual({ runId: 'missing-run', imported: false, reason: 'no such run in persistence' });
  });
});

describe('importRun with a nested composition', () => {
  it('types and times child boundaries from the persisted child graphs', async () => {
    const echo = tool({
      name: 'echo',
      description: 'Echoes.',
      parameters: z.object({}),
      execute: () => ({ said: 'hi' }),
    });
    const leaf = graph({ name: 'leaf', nodes: [node({ id: 'emit', type: 'tool', toolId: 'echo', tools: [echo] })] });
    const nested = graph({ name: 'nested-flow', nodes: [subgraph(leaf, { id: 'descend' })] });
    const run = await runRecorded(nested, { goal: 'Nested external run.' });

    const outcome = await importRun(stackOver(run), run.runId);
    const timing = await loadNodeTiming(outcome.dir!);

    expect(outcome.imported).toBe(true);
    expect(timing['descend']?.type).toBe('subgraph');
    expect(timing['descend/emit']?.type).toBe('tool');
    expect(timing['descend']!.total_ms).toBeGreaterThanOrEqual(timing['descend/emit']!.total_ms);
  });
});

describe('importAll', () => {
  it('imports what is missing and skips what already landed', async () => {
    const stack = stackOver(recorded);

    const first = await importAll(stack);
    const second = await importAll(stack);

    expect(first.filter((o) => o.imported)).toHaveLength(1);
    expect(second).toEqual([]);
  });
});

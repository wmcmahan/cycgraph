/**
 * Composition tests: an `a2a` node INSIDE a subgraph, run live against the
 * scenario servers in `@cycgraph/test-servers`.
 *
 * Every value here crosses two delegation boundaries each way — parent →
 * child graph → remote agent and back — so these prove what the unit tests
 * structurally cannot: that the wiring, taint, interface validation, and
 * nested pause machinery survive being stacked. The first draft of this
 * suite caught the subgraph executor not forwarding `a2aRegistry` /
 * `a2aClient` to its child runner at all.
 *
 * Gated like the postgres suite: SKIPS unless `A2A_SCENARIO_SERVER` names
 * a running scenario server. To run:
 *
 *   npm run start --workspace=packages/test-servers   # in another shell
 *   A2A_SCENARIO_SERVER=http://127.0.0.1:4001 npx vitest run test/composition.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  a2a,
  graph,
  subgraph,
  run,
  state,
  GraphRunner,
  InMemoryA2AServerRegistry,
  SubgraphInterfaceError,
} from '@cycgraph/orchestrator';
import type { Graph } from '@cycgraph/orchestrator';
import { createA2AClient } from '../src/index.js';

const SERVER = process.env.A2A_SCENARIO_SERVER;

const registry = new InMemoryA2AServerRegistry();
const client = createA2AClient();
const runnerOptions = { a2aRegistry: registry, a2aClient: client };

async function registerScenario(id: string): Promise<void> {
  await registry.saveServer({
    id,
    name: id,
    agentCardUrl: `${SERVER}/${id}/.well-known/agent-card.json`,
  });
}

/**
 * A child graph whose only work is delegated to a remote agent, with a
 * declared output so the subgraph boundary has a schema to enforce.
 */
function remoteChild(scenarioId: string, notesSchema: Record<string, unknown>): Graph {
  return graph({
    name: `remote-${scenarioId}`,
    nodes: [
      a2a(scenarioId, {
        id: 'call',
        reads: ['topic'],
        inputs: { topic: 'query' },
        outputs: { report: 'notes' },
      }),
    ],
    inputs: { topic: { schema: { type: 'string' } } },
    outputs: { notes: { schema: notesSchema } },
  });
}

/** A parent that embeds the child and renames every key at its boundary. */
function parentOf(child: Graph): Graph {
  return graph({
    name: 'briefing',
    nodes: [
      subgraph(child, {
        id: 'research',
        reads: ['subject'],
        inputs: { subject: 'topic' },
        outputs: { notes: 'findings' },
      }),
    ],
  });
}

/** Runner options for driving `GraphRunner` directly. */
function directOptions(child: Graph) {
  return {
    ...runnerOptions,
    loadGraph: async (id: string) => (id === child.id ? child : null),
  };
}

describe.skipIf(!SERVER)('a2a inside a subgraph (live)', () => {
  beforeAll(() => {
    process.env.CYCGRAPH_ALLOW_PRIVATE_A2A_URLS = 'true';
  });

  it('carries a structured remote value up through both boundaries', async () => {
    await registerScenario('echo');
    const parent = parentOf(remoteChild('echo', { type: 'object' }));

    const memory = await run(
      parent,
      { goal: 'research', memory: { subject: 'batteries' } },
      { runner: runnerOptions },
    );

    expect(memory.findings).toEqual({ query: 'batteries' });
  });

  it('keeps remote data tainted across both crossings', async () => {
    await registerScenario('echo');
    const child = remoteChild('echo', { type: 'object' });
    const parent = parentOf(child);
    const runner = new GraphRunner(
      parent,
      state({ workflowId: parent.id, goal: 'research', memory: { subject: 'batteries' } }),
      directOptions(child),
    );

    const final = await runner.run();

    expect(final.taint_registry.findings).toMatchObject({ source: 'a2a', server_id: 'echo' });
  });

  it('lets only mapped keys through either boundary', async () => {
    await registerScenario('multi-artifact');
    const parent = parentOf(remoteChild('multi-artifact', { type: 'string' }));

    const memory = await run(
      parent,
      { goal: 'research', memory: { subject: 'batteries' } },
      { runner: runnerOptions },
    );

    expect(memory.findings).toBe('the findings');
    expect(memory).not.toHaveProperty('confidence');
    expect(memory).not.toHaveProperty('unmapped');
  });

  it('enforces the child declared output schema against the remote value', async () => {
    await registerScenario('echo');
    const parent = parentOf(remoteChild('echo', { type: 'number' }));

    await expect(
      run(parent, { goal: 'research', memory: { subject: 'batteries' } }, { runner: runnerOptions }),
    ).rejects.toThrow(SubgraphInterfaceError);
  });

  it('propagates a remote rejection to the parent with its cause intact', async () => {
    await registerScenario('rejects');
    const parent = parentOf(remoteChild('rejects', { type: 'string' }));

    await expect(
      run(parent, { goal: 'research', memory: { subject: 'batteries' } }, { runner: runnerOptions }),
    ).rejects.toMatchObject({ name: 'A2ATaskFailedError', state: 'rejected', retryable: false });
  });

  it('pauses the parent when the remote agent asks a question two boundaries down', async () => {
    await registerScenario('asks-question');
    const child = remoteChild('asks-question', { type: 'object' });
    const parent = parentOf(child);
    const runner = new GraphRunner(
      parent,
      state({ workflowId: parent.id, goal: 'research', memory: { subject: 'batteries' } }),
      directOptions(child),
    );

    const paused = await runner.run();

    expect(paused.status).toBe('waiting');
    expect(paused.subgraph_checkpoints).toHaveProperty('research');
  });

  it('resumes the same remote task through both boundaries and completes', async () => {
    await registerScenario('asks-question');
    const child = remoteChild('asks-question', { type: 'object' });
    const parent = parentOf(child);
    const first = new GraphRunner(
      parent,
      state({ workflowId: parent.id, goal: 'research', memory: { subject: 'batteries' } }),
      directOptions(child),
    );
    const paused = await first.run();

    const second = new GraphRunner(parent, paused, directOptions(child));
    second.applyHumanResponse({ decision: 'approved', data: 'EMEA' });
    const final = await second.run();

    expect(final.status).toBe('completed');
    expect(final.memory.findings).toEqual({ answered_with: 'EMEA' });
    expect(final.subgraph_checkpoints).toEqual({});
  });
});

describe.skipIf(Boolean(SERVER))('a2a inside a subgraph (gate)', () => {
  it('is skipped without A2A_SCENARIO_SERVER; start packages/test-servers to run it', () => {
    expect(SERVER).toBeUndefined();
  });
});

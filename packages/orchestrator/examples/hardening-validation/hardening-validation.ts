/**
 * Live validation of the 2026-08-05 hardening fixes — real LLM calls, no mocks.
 *
 * Scenario 1 — facade + grant-less supervisor + tainted custom tool:
 *   A supervisor with NO declared reads routes a researcher (which must call a
 *   taints:true custom tool) and a writer. Proves on a live run that
 *   (a) derived reads reach the supervisor (it routes on real worker output),
 *   (b) the security policy sees those derived reads as tainted_read_keys,
 *   (c) run() scoping + facade compilation work end to end.
 *
 * Scenario 2 — subgraph child inherits scoped registry + tools:
 *   A parent graph's subgraph node runs a child whose agent exists ONLY in a
 *   run-scoped registry and whose only knowledge source is a custom tool
 *   passed via GraphRunnerOptions.tools. Pre-fix, the child runner received
 *   neither, so this workflow could not produce the canned answer.
 *
 * Usage (local models, no API key — requires `ollama serve` + a pulled model):
 *   npx tsx examples/hardening-validation/hardening-validation.ts
 *   OLLAMA_MODEL=qwen2.5:7b npx tsx examples/hardening-validation/hardening-validation.ts
 */

import { z } from 'zod';
import {
  agent,
  node,
  graph,
  run,
  tool,
  GraphRunner,
  createGraph,
  createWorkflowState,
  InMemoryAgentRegistry,
  createProviderRegistry,
  registerOllamaProvider,
  supervisor,
} from '@cycgraph/orchestrator';
import type { SecurityPolicy } from '@cycgraph/orchestrator';
import { createOpenAI } from '@ai-sdk/openai';

// Local-model run: everything resolves through a run-scoped provider
// registry (which live-tests the providers scoping path as well).
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b';
const providers = createProviderRegistry();
registerOllamaProvider(providers, ({ baseURL }) => {
  const provider = createOpenAI({ baseURL: `${baseURL}/v1`, apiKey: 'ollama' });
  return (modelId) => provider.chat(modelId);
});

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ check: name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

// ─── Scenario 1: facade + derived supervisor reads + taint gating ───────────

console.log('\n━━━ Scenario 1: grant-less supervisor over a tainted-tool researcher ━━━');

const docsQueries: string[] = [];
const lookupDocs = tool({
  name: 'lookup_docs',
  description: 'Look up the internal engineering docs for a protocol name. The ONLY source of truth.',
  parameters: z.object({ query: z.string() }),
  taints: true,
  execute: ({ query }) => {
    docsQueries.push(query);
    return 'The Zephyr-9 protocol uses a three-phase commit with vector-clock reconciliation and a 250ms quorum deadline.';
  },
});

const researcher = agent({
  model: MODEL,
  provider: 'ollama',
  instructions:
    'You are a research specialist. You know NOTHING about internal protocols from training. ' +
    'Call lookup_docs to get the facts, then write concise research notes containing exactly what it returned.',
  tools: ['lookup_docs'],
});

const writer = agent({
  model: MODEL,
  provider: 'ollama',
  instructions:
    'You are a technical writer. Turn the research notes into a 3-sentence explanation for new engineers. ' +
    'Preserve every specific technical detail from the notes.',
});

const research = node({ id: 'research', agent: researcher, reads: ['goal'], writes: 'notes' });
const write = node({ id: 'write', agent: writer, reads: ['goal', 'notes'], writes: 'draft' });
const lead = supervisor(
  agent({
    model: MODEL,
    provider: 'ollama',
    instructions:
      'You coordinate a research-then-write pipeline. Delegate to research first, then write, ' +
      'then finish once a complete draft exists in memory.',
  }),
  { id: 'supervisor', manages: [research, write], maxIterations: 6 },
);

const policyObservations: Array<{ nodeId: string; taintedKeys: string[] }> = [];
const securityPolicy: SecurityPolicy = (ctx) => {
  policyObservations.push({ nodeId: ctx.node.id, taintedKeys: [...ctx.tainted_read_keys] });
  return { effect: 'monitor', sensitivity: 'low', reason: 'live-validation probe' };
};

const pipeline = graph({
  name: 'hardening-validation-supervisor',
  nodes: [lead, research, write],
  edges: [
    { from: lead, to: research },
    { from: lead, to: write },
    { from: research, to: lead },
    { from: write, to: lead },
  ],
  startNode: lead,
  endNodes: [],
});

const memory = await run(
  pipeline,
  { goal: 'Explain the Zephyr-9 protocol for new engineers.' },
  { providers, runner: { securityPolicy, tools: [lookupDocs] } },
);

const notes = String(memory.notes ?? '');
const draft = String(memory.draft ?? '');
const supervisorTaintObs = policyObservations.filter((o) => o.nodeId === 'supervisor');

check('workflow completed with both worker outputs', notes.length > 0 && draft.length > 0,
  `notes=${notes.length} chars, draft=${draft.length} chars`);
check('custom tool was actually invoked', docsQueries.length >= 1,
  `lookup_docs called ${docsQueries.length}x (queries: ${docsQueries.join(' | ')})`);
check('canned tool fact survived to the final draft', /vector-clock|250\s?ms|three-phase/i.test(draft),
  draft.slice(0, 140).replace(/\n/g, ' '));
check('security policy saw DERIVED supervisor reads as tainted', supervisorTaintObs.some((o) => o.taintedKeys.includes('notes')),
  `supervisor policy calls: ${JSON.stringify(supervisorTaintObs)}`);

// ─── Scenario 2: subgraph child inherits scoped registry + tools ────────────

console.log('\n━━━ Scenario 2: subgraph child with run-scoped registry and custom tool ━━━');

let fxCalls = 0;
const fxRate = tool({
  name: 'fx_rate',
  description: 'Get the live USD/EUR exchange rate. The ONLY source for rates.',
  parameters: z.object({ pair: z.string() }),
  execute: () => {
    fxCalls += 1;
    return { pair: 'USD/EUR', rate: 0.9123, asOf: '2026-08-04T16:00:00Z' };
  },
});

const scopedRegistry = new InMemoryAgentRegistry();
const analystId = scopedRegistry.register({
  name: 'fx-analyst',
  model: MODEL,
  provider: 'ollama',
  systemPrompt:
    'You are an FX analyst. You have no rate knowledge of your own — call fx_rate, ' +
    'then answer with the exact rate and timestamp it returns.',
  tools: ['fx_rate'],
  permissions: null,
});

const childGraph = createGraph({
  name: 'fx-child',
  description: 'single analyst worker',
  nodes: [{ id: 'analyst', type: 'agent', agentId: analystId, readKeys: ['goal'], writeKeys: ['rate_answer'] }],
  edges: [],
  startNode: 'analyst',
  endNodes: ['analyst'],
});

const parentGraph = createGraph({
  name: 'fx-parent',
  description: 'wraps the analyst in a subgraph',
  nodes: [{
    id: 'sub',
    type: 'subgraph',
    subgraphConfig: { subgraphId: childGraph.id, outputMapping: { rate_answer: 'rate_answer' } },
    readKeys: ['goal'],
    writeKeys: ['rate_answer'],
  }],
  edges: [],
  startNode: 'sub',
  endNodes: ['sub'],
});

const runner = new GraphRunner(
  parentGraph,
  createWorkflowState({ workflowId: parentGraph.id, goal: 'What is the current USD/EUR rate?' }),
  {
    registry: scopedRegistry,
    providers,
    tools: [fxRate],
    loadGraph: async (graphId) => (graphId === childGraph.id ? childGraph : null),
  },
);
const finalState = await runner.run();
const rateAnswer = String(finalState.memory.rate_answer ?? '');

check('parent workflow completed through the subgraph', finalState.status === 'completed',
  `status=${finalState.status}`);
check('child resolved its agent from the SCOPED registry and called the threaded tool', fxCalls >= 1,
  `fx_rate called ${fxCalls}x`);
check('canned rate reached the parent memory via output mapping', rateAnswer.includes('0.9123'),
  rateAnswer.slice(0, 140).replace(/\n/g, ' '));

// ─── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n━━━ ${results.length - failed.length}/${results.length} live checks passed ━━━`);
process.exit(failed.length === 0 ? 0 : 1);

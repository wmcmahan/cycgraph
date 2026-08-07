/**
 * Research & Write — Runnable Example (authoring facade)
 *
 * A 2-node linear workflow: a Researcher agent gathers notes, then a Writer
 * agent produces a polished draft. Authored with the facade vocabulary —
 * `agent` (a capability), `node` (a placement), `graph` (the compiler),
 * `run` (the executor) — which compiles to the exact same wire as the raw
 * graph API. For the explicit, fully-wired version (custom persistence,
 * event listeners, provider registries), see the other examples.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
 */

import { agent, node, graph, run } from '@cycgraph/orchestrator';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY is required');
  process.exit(1);
}

const researcher = agent({
  model: 'claude-sonnet-4-6',
  instructions: 'You are a research specialist. Produce concise, factual research notes as bullet points.',
});

const writer = agent({
  model: 'claude-sonnet-4-6',
  instructions: 'You are a professional writer. Turn the research notes into a clear summary under 300 words.',
});

const research = node({ id: 'research', agent: researcher, reads: ['goal', 'constraints'], writes: 'research_notes' });
const write = node({ id: 'write', agent: writer, reads: ['goal', 'research_notes'], writes: 'draft' });

const workflow = graph({
  name: 'Research & Write',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});

const { research_notes, draft } = await run(workflow, {
  goal: 'Explain how large language models work, including transformers, attention, and training data.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language'],
});

console.log('\n═══ Research Notes ═══\n' + (research_notes ?? '(none)'));
console.log('\n═══ Final Draft ═══\n' + (draft ?? '(none)'));

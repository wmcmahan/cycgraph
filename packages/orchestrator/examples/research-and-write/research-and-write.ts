/**
 * Research & Write — the smallest useful graph: gather notes, then write.
 *
 * Run:  CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/research-and-write/research-and-write.ts
 * See:  ./README.md
 */

import { agent, node, graph, run } from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const researcher = agent({
  model: MODEL,
  provider: PROVIDER,
  instructions: 'You are a research specialist. Produce concise, factual research notes as bullet points.',
});

const writer = agent({
  model: MODEL,
  provider: PROVIDER,
  instructions: 'You are a professional writer. Turn the research notes into a clear summary under 300 words.',
});

const research = node({ id: 'research', agent: researcher, writes: 'research_notes' });
const write = node({ id: 'write', agent: writer, reads: [research.writes], writes: 'draft' });

const workflow = graph({
  name: 'Research & Write',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});

const { research_notes, draft } = await run(workflow, {
  goal: 'Explain how large language models work, including transformers, attention, and training data.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language'],
}, { runner: { providers: exampleProviders() } });

console.log('\n═══ Research Notes ═══\n' + (research_notes ?? '(none)'));
console.log('\n═══ Final Draft ═══\n' + (draft ?? '(none)'));

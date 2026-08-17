/**
 * Composition — a whole graph embedded as one node.
 *
 * Run:  CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/composition/composition.ts
 * See:  ./README.md for what crosses the boundary and what stays isolated.
 */

import { agent, memoryKeys, node, subgraph, graph, run } from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

// ─── Self-contained research subgraph ─────────────────

const mem = memoryKeys({
  research_topic: { seeded: true, schema: { type: 'string' } },
});

const gather = node({
  id: 'gather',
  agent: agent({
    model: MODEL,
    provider: PROVIDER,
    instructions: 'You are a research specialist. Produce concise, factual research notes as bullet points.',
  }),
  reads: ['topic'],
  writes: 'notes',
});

const summarize = node({
  id: 'summarize',
  agent: agent({
    model: MODEL,
    provider: PROVIDER,
    instructions: 'Condense the research notes into a tight summary of the five most important points.',
  }),
  reads: [gather.writes],
  writes: 'summary',
});

const researchBlock = graph({
  name: 'research-block',
  nodes: [gather, summarize],
  edges: [{ from: gather, to: summarize }],
});

// ─── The parent workflow embeds the research subgraph and formats its output ─────────

const research = subgraph(researchBlock, {
  id: 'research',
  reads: [mem.research_topic],
  inputs: { [mem.research_topic]: 'topic' },
  outputs: { summary: 'findings' },
});

const brief = node({
  id: 'brief',
  agent: agent({
    model: MODEL,
    provider: PROVIDER,
    instructions: 'Turn the findings into a short executive brief with a headline and three takeaways.',
  }),
  reads: [research.outputs.summary],
  writes: 'executive_brief',
});

const briefing = graph({
  name: 'briefing',
  nodes: [research, brief],
  edges: [{ from: 'research', to: brief }],
});

const { findings, executive_brief } = await run(briefing, {
  goal: 'Produce an executive brief on the state of solid-state batteries.',
  memory: mem.seed({ research_topic: 'solid-state battery commercialization in 2026' }),
}, { runner: { providers: exampleProviders() } });

console.log('\n═══ Findings (mapped out of the research block) ═══\n' + (findings ?? '(none)'));
console.log('\n═══ Executive Brief ═══\n' + (executive_brief ?? '(none)'));

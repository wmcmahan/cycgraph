/**
 * Composition — Runnable Example (subgraph facade)
 *
 * Whole graphs as reusable blocks: a research pipeline is built once as its
 * own graph, then embedded in a briefing workflow with `subgraph()`. The
 * child runs in isolated state; memory crosses only through the `inputs` /
 * `outputs` mappings, and `run()` resolves the child and registers its
 * agents automatically — no hand-wired loadGraph.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/composition/composition.ts
 */

import { agent, node, subgraph, graph, run } from '@cycgraph/orchestrator';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY is required');
  process.exit(1);
}

// ─── The reusable block: a self-contained research graph ─────────────────

const gather = node({
  id: 'gather',
  agent: agent({
    model: 'claude-sonnet-4-6',
    instructions: 'You are a research specialist. Produce concise, factual research notes as bullet points.',
  }),
  reads: ['topic'],
  writes: 'notes',
});

const summarize = node({
  id: 'summarize',
  agent: agent({
    model: 'claude-sonnet-4-6',
    instructions: 'Condense the research notes into a tight summary of the five most important points.',
  }),
  reads: ['notes'],
  writes: 'summary',
});

const researchBlock = graph({
  name: 'research-block',
  nodes: [gather, summarize],
  edges: [{ from: gather, to: summarize }],
});

// ─── The parent workflow embeds the block and formats its output ─────────
// The child sees only the mapped keys, never the parent blackboard. Its
// internal node ids and memory keys are its own business — the mappings
// are the contract.

const brief = node({
  id: 'brief',
  agent: agent({
    model: 'claude-sonnet-4-6',
    instructions: 'Turn the findings into a short executive brief with a headline and three takeaways.',
  }),
  reads: ['findings'],
  writes: 'executive_brief',
});

const briefing = graph({
  name: 'briefing',
  nodes: [
    subgraph(researchBlock, {
      id: 'research',
      reads: ['research_topic'],
      inputs:  { research_topic: 'topic' },  // parent key → child key
      outputs: { summary: 'findings' },      // child key → parent key
      // No `writes` needed: the output mapping already names `findings` as a
      // destination, and that config IS the write grant. `reads` stays
      // explicit — visibility into parent memory is never inferred.
    }),
    brief,
  ],
  edges: [{ from: 'research', to: brief }],
});

const { findings, executive_brief } = await run(briefing, {
  goal: 'Produce an executive brief on the state of solid-state batteries.',
  memory: { research_topic: 'solid-state battery commercialization in 2026' },
});

console.log('\n═══ Findings (mapped out of the research block) ═══\n' + (findings ?? '(none)'));
console.log('\n═══ Executive Brief ═══\n' + (executive_brief ?? '(none)'));

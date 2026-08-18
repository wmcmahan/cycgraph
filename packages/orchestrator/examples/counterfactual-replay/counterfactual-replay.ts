/**
 * Counterfactual Replay — run a recorded run again, differently.
 *
 * Run:  CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/counterfactual-replay/counterfactual-replay.ts
 * See:  ./README.md
 */

import { agent, node, graph, runRecorded, fork, forkEach, change } from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

// ─── 1. A graph worth forking ───────────────────────────────────────

const researcher = agent({
  model: MODEL,
  provider: PROVIDER,
  instructions: 'You are a research specialist. Produce concise, factual research notes as bullet points.',
});

const writer = agent({
  model: MODEL,
  provider: PROVIDER,
  instructions: 'You are a professional writer. Turn the research notes into a clear summary under 200 words.',
});

const research = node({ id: 'research', agent: researcher, writes: 'research_notes' });
const write = node({ id: 'write', agent: writer, reads: [research.writes], writes: 'draft' });

const workflow = graph({
  name: 'Research & Write',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});

// ─── 2. Record a run ────────────────────────────────────────────────

const base = await runRecorded(workflow, {
  goal: 'Explain how vaccines create immunity.',
  constraints: ['Keep the draft under 200 words'],
}, { runner: { providers: exampleProviders() } });

console.log('\n═══ Original draft ═══\n' + (base.memory['draft'] ?? '(none)'));

// ─── 3. Ask one what-if ─────────────────────────────────────────────

const terse = await fork(base, {
  at: { beforeNode: 'write' },
  change: change.prompt('write', 'Rewrite the notes as exactly three short bullet points. No prose.'),
  runner: { providers: exampleProviders() },
});

console.log('\n═══ Counterfactual draft ═══\n' + (terse.state?.memory['draft'] ?? '(none)'));
console.log('\n' + terse.explain());

// ─── 4. Ask several at once ─────────────────────────────────────────

const sweep = await forkEach(base, {
  at: { beforeNode: 'write' },
  variants: {
    terse: change.prompt('write', 'Summarize in exactly three bullet points.'),
    child: change.prompt('write', 'Explain it to a ten-year-old.'),
    cold: change.temperature('write', 0),
  },
  runner: { providers: exampleProviders() },
});

console.log('\n' + sweep.explain());

for (const variant of sweep.variants) {
  const draft = variant.samples[0]?.state?.memory['draft'];
  console.log(`\n─── ${variant.name} ───\n${draft ?? variant.error?.message ?? '(none)'}`);
}

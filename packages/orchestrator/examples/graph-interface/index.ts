/**
 * Graph Interface — Runnable Example
 * 
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/graph-interface/index.ts
 */

import { run, validateGraph, SubgraphInterfaceError } from '@cycgraph/orchestrator';
import { exampleProviders, missingCredentials } from '../_model.js';
import { briefingGraph } from './briefingGraph';
import { contextCompressor } from './context';
import { memoryRetriever, memoryWriter } from './memory';

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const validation = validateGraph(briefingGraph);

for (const error of validation.errors) {
  console.log(`error: ${error}`);
}
for (const warning of validation.warnings) {
  console.log(`warning: ${warning}`);
}

try {
  const topic = 'solid-state battery commercialization in 2026';
  const goal = `Produce an executive brief on ${topic}.`;

  const { executive_brief } = await run(
    briefingGraph,
    {
      goal,
      memory: { research_topic: topic, research_depth: 'brief' },
    },
    { runner: { providers: exampleProviders(), memoryRetriever, memoryWriter, contextCompressor } },
  );

  console.log('\n── Executive Brief ──\n' + (executive_brief ?? '(none)'));

} catch (error) {
  if (!(error instanceof SubgraphInterfaceError)) {
    throw error;
  }
  process.exit(1);
}

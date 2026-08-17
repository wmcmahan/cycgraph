import { subgraph, graph } from '@cycgraph/orchestrator';
import { researchGraph } from '../reaserchGraph/index.js';
import { briefNode } from './nodes/index.js';
import { mem } from '../keys.js';

export const briefingGraph = graph({
  name: 'briefing',
  nodes: [
    subgraph(researchGraph, {
      id: 'research',
      reads: [mem.research_topic, mem.research_depth],
      inputs: { [mem.research_topic]: 'topic', [mem.research_depth]: 'depth' },
      outputs: { summary: 'findings' },
    }),
    briefNode,
  ],
  edges: [{ from: 'research', to: briefNode }],
});

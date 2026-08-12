import { subgraph, graph } from '@cycgraph/orchestrator';
import { researchGraph } from '../reaserchGraph';
import { briefNode } from './nodes';

export const briefingGraph = graph({
  name: 'briefing',
  nodes: [
    subgraph(researchGraph, {
      id: 'research',
      reads: ['research_topic', 'research_depth'],
      inputs: { research_topic: 'topic', research_depth: 'depth' },
      outputs: { summary: 'findings' },
    }),
    briefNode,
  ],
  edges: [{ from: 'research', to: briefNode }],
});

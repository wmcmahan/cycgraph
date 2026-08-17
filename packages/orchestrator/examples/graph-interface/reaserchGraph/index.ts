import { z } from 'zod';
import { graph } from '@cycgraph/orchestrator';
import { gatherNode, summarizeNode, reflectNode } from './nodes/index.js';

export const researchGraph = graph({
  name: 'research-block',
  description: 'Researches a topic, returns notes plus a summary, and distils lessons for future runs.',
  nodes: [gatherNode, summarizeNode, reflectNode],
  edges: [
    { from: gatherNode, to: summarizeNode },
    { from: summarizeNode, to: reflectNode },
  ],
  inputs: {
    topic: {
      schema: z.string().min(3),
      description: 'The subject to research'
    },
    depth: {
      schema: z.enum(['brief', 'deep']).default('brief'),
      description: 'How much detail to gather'
    },
  },
  outputs: {
    notes: {
      schema: z.string(),
      description: 'Raw bullet-point findings'
    },
    summary: {
      schema: z.string(),
      description: 'The five most important points'
    },
  },
});

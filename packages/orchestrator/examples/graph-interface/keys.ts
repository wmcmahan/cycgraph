/**
 * The memory keys this example's graphs share.
 *
 * `briefingGraph` reads them and maps them into its child; `index.ts` seeds
 * them into the run. The two live in different modules, so a local constant
 * could not reach both and the names would be typed twice.
 */

import { memoryKeys } from '@cycgraph/orchestrator';

export const mem = memoryKeys({
  research_topic: {
    seeded: true,
    schema: { type: 'string' },
    description: 'What the briefing is about',
  },
  research_depth: {
    seeded: true,
    schema: { type: 'string' },
    description: 'How much depth the research step should go to',
  },
});

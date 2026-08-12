import { node } from '@cycgraph/orchestrator';
import { gatherAgent, summarizeAgent } from '../agents';
import { LESSON_TAG } from '../../memory';

export const gatherNode = node({
  id: 'gather',
  agent: gatherAgent,
  reads: ['topic', 'depth'],
  writes: 'notes',
  // The read half of the loop. This directive is what activates
  // `memoryRetriever` — a retriever wired on the runner sits dormant until
  // some node asks for memory. On run 1 there is nothing to retrieve; on
  // run 2 the lessons `reflect` wrote below arrive here as a
  // `## Relevant Memory` section of the system prompt.
  memoryQuery: { tags: [LESSON_TAG], maxFacts: 10 },
});

export const summarizeNode = node({
  id: 'summarize',
  agent: summarizeAgent,
  reads: ['notes'],
  writes: 'summary',
});

// The write half. A reflection node distils `notes` into atomic facts and
// persists them through `memoryWriter`. It lives INSIDE the block, so the
// block carries its own learning behaviour wherever it is composed — the
// parent supplies the store, not the wiring.
export const reflectNode = node({
  id: 'reflect',
  type: 'reflection',
  reads: ['notes'],
  reflectionConfig: {
    sourceKeys: ['notes'],
    // No LLM call, no extra tokens: an inline sentence splitter. Swap for
    // { type: 'llm', agentId, maxFacts } when the source is prose that
    // needs real distillation rather than sentence extraction.
    extractor: { type: 'rule_based', minSentenceLength: 25 },
    tags: ['lesson', LESSON_TAG],
  },
});

/**
 * propose — the analyst at work: study the signal, propose one edit.
 *
 * Reads the sense result and the last shape verdict (so a retry fixes what
 * the shape check named). Draws the shared lesson pool — nothing writes a
 * tune-specific tag, and cross-workflow lessons are the relevant ones.
 *
 * @module maintenance/tune/nodes/propose
 */

import { node } from '@cycgraph/orchestrator';
import type { TuneContext } from '../context.js';
import type { analystAgent } from '../agents/analyst.js';
import type { senseNode } from './sense.js';

/** The analyst agent node, reading the sense result and prior shape verdict. */
export function proposeNode(
  c: TuneContext,
  analyst: ReturnType<typeof analystAgent>,
  sense: ReturnType<typeof senseNode>,
) {
  return node({
    id: 'propose',
    agent: analyst,
    failurePolicy: { timeoutMs: 900_000 },
    reads: [sense.result, 'shape_result'],
    writes: 'proposal',
    // The shared pool: nothing writes wf:tune (no reflection tail here),
    // and cross-workflow lessons are the relevant ones.
    ...(c.env.memory ? { memoryQuery: { tags: ['lesson'], maxFacts: 6 } } : {}),
  });
}

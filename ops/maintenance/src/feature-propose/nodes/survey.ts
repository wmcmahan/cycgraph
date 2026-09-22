/**
 * survey — the surveyor at work: read the tree, write survey notes.
 *
 * @module maintenance/feature-propose/nodes/survey
 */

import { node } from '@cycgraph/orchestrator';
import type { surveyorAgent } from '../agents/surveyor.js';

/** The surveyor agent node, reading the clone map and writing survey notes. */
export function surveyNode(surveyor: ReturnType<typeof surveyorAgent>) {
  return node({
    id: 'survey',
    agent: surveyor,
    failurePolicy: { timeoutMs: 1_200_000 },
    reads: ['clone_result'],
    writes: 'survey',
  });
}

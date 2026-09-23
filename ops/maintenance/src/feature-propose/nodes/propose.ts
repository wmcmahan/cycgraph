/**
 * propose — the drafter at work: survey notes into one proposal.
 *
 * Reads the survey notes and the last shape result (so a retry fixes
 * exactly what the report named) and writes the proposal.
 *
 * @module maintenance/feature-propose/nodes/propose
 */

import { node } from '@cycgraph/orchestrator';
import type { drafterAgent } from '../agents/drafter.js';

/** The drafter agent node, reading the survey and prior shape result. */
export function proposeNode(drafter: ReturnType<typeof drafterAgent>) {
  return node({
    id: 'propose',
    agent: drafter,
    failurePolicy: { timeoutMs: 300_000 },
    reads: ['survey', 'shape_result'],
    writes: 'proposal',
  });
}

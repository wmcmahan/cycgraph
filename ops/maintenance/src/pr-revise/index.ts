/**
 * pr-revise — human review feedback, closed as a loop.
 *
 * The PR is the durable state: a reviewer requesting changes or
 * commenting on a maintenance pull request dispatches this run, which
 * reads the feedback, revises the same branch in a fresh clone, and
 * pushes — updating the PR in place — then replies with what it did:
 * threaded into each diff-anchored comment's own conversation, plus a
 * timeline summary for the rest.
 * This is the CI-shaped form of human-in-the-loop: no paused run waits
 * for the human; the human's event starts the next run.
 *
 * The reviser gets the full editing surface plus run_check, the same
 * tree-mutation discipline as implement-ticket's acceptance, and the
 * repository's checks as its gate. It never opens or merges anything:
 * the PR it updates still ends at the human verdict.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the agent, and the graph, each from its own file.
 *
 * @module maintenance/pr-revise
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { buildReviseContext, params } from './context.js';
import type { Params } from './context.js';
import { reviseTools } from './tools/index.js';
import { reviserAgent } from './agents/index.js';
import { reviseNodes } from './nodes/index.js';
import { reviseGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The pr-revise workflow. */
export function prRevise(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'pr-revise',
    title: 'Address human review feedback on a maintenance PR',
    covers: ['maintenance', 'review', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const context = await buildReviseContext(p, env);
      const tools = reviseTools(context);
      const reviser = reviserAgent(context, tools);
      const nodes = reviseNodes(context, tools, reviser);
      return reviseGraph(context, nodes);
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'gather_result' },
    ],
  };
}

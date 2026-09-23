/**
 * tune — the fleet proposing measured changes to its own source.
 *
 * The loop that closes recursive self-improvement at the structural level:
 * sense reads the scorecard and the target workflow's recent failures from
 * the recorded corpus; an analyst with read-only hands locates the exact
 * instruction text implicated and proposes one find/replace edit with a
 * hypothesis; trials run the target workflow in dry mode as subprocesses —
 * control and variant each from a clone of the same committed base,
 * differing only by the edit — so what is measured is the real source
 * change, end to end; and a variant that wins becomes a ticket carrying the
 * hypothesis, the measured table, and the exact diff. Nothing lands without
 * the maintenance-approved label and a human merge.
 *
 * Trials run with the database credential stripped: they must neither
 * pollute the recorded corpus nor differ by lesson injection.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the analyst, the nodes, and the graph, each from its
 * own file. The pure proposal/ticket/trial helpers live in `proposal.js`
 * and are re-exported here for the package barrel and the consumers
 * (implement-ticket, run.ts).
 *
 * @module maintenance/tune
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { buildTuneContext, params } from './context.js';
import type { Params } from './context.js';
import { tuneTools } from './tools/index.js';
import { analystAgent } from './agents/index.js';
import { tuneNodes } from './nodes/index.js';
import { tuneGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

// The pure surface, re-exported for the barrel and consumers.
export {
  MaintainResultSchema,
  TUNABLE,
  COST_WIN_RATIO,
  parseTuneProposal,
  renderTuneTicket,
  parseTuneTicket,
  resolveSourcePath,
  variantWins,
  tuneKey,
} from './proposal.js';
export type { TuneProposal, TuneTicketFields, ArmResult } from './proposal.js';

/** The tune workflow. */
export function tunePropose(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'tune',
    title: 'Propose one measured change to a workflow\'s own source',
    covers: ['maintenance', 'tuning'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const context = await buildTuneContext(p, env);
      const tools = tuneTools(context);
      const analyst = analystAgent(context, tools);
      const nodes = tuneNodes(context, tools, analyst);
      return tuneGraph(context, nodes);
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'sense_result' },
    ],
  };
}

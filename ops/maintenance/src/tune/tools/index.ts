/**
 * The analyst's hands and the run's tool-node primitives.
 *
 * `hands` are the read-only tools the analyst drives over the repository
 * source; the tool nodes are `sense` (read the corpus), `shape` (validate
 * the edit), `trial` (measure control vs variant), and `ticket` (file the
 * winner). Each is its own file; this barrel binds them all to one
 * {@link TuneContext}.
 *
 * @module maintenance/tune/tools
 */

import type { TuneContext } from '../context.js';
import { tuneHands } from './hands.js';
import { senseTool } from './sense.js';
import { shapeTool } from './shape.js';
import { trialTool } from './trial.js';
import { ticketTool } from './ticket.js';

/** Build every tool the run needs, bound to the given context. */
export function tuneTools(c: TuneContext) {
  return {
    hands: tuneHands(c),
    sense: senseTool(c),
    shape: shapeTool(c),
    trial: trialTool(c),
    ticket: ticketTool(c),
  };
}

/** The analyst's hands and the run's tool-node primitives. */
export type TuneTools = ReturnType<typeof tuneTools>;

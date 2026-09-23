/**
 * The surveyor's hands and the run's tool-node primitives.
 *
 * `hands` are the read-only search/read tools the surveyor drives; the tool
 * nodes bracket the drafting — `clone` sets up and maps the workspace,
 * `shape` validates the proposal, and `ticket` files it. Each is its own
 * file; this barrel binds them all to one {@link FeatProposeContext}.
 *
 * @module maintenance/feature-propose/tools
 */

import type { FeatProposeContext } from '../context.js';
import { featProposeHands } from './hands.js';
import { cloneTool } from './clone.js';
import { shapeTool } from './shape.js';
import { ticketTool } from './ticket.js';

/** Build every tool the run needs, bound to the given context. */
export function featProposeTools(c: FeatProposeContext) {
  return {
    hands: featProposeHands(c),
    clone: cloneTool(c),
    shape: shapeTool(c),
    ticket: ticketTool(c),
  };
}

/** The surveyor's hands and the run's tool-node primitives. */
export type FeatProposeTools = ReturnType<typeof featProposeTools>;

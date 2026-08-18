/**
 * Errors raised while forking a recorded run.
 *
 * @module replay/errors
 */

import { CycgraphError } from '../errors.js';

/** A fork that cannot be set up: no such run, nothing recorded, changes that collide. */
export class ForkError extends CycgraphError {
  constructor(message: string) {
    super(message);
    this.name = 'ForkError';
  }
}

/**
 * The base run's log was written under different reducer semantics.
 *
 * Recovery only warns about this, because reconstructing an approximate state
 * still beats losing the run. A fork refuses: its entire output is a comparison
 * between two states, and a version skew makes them incomparable.
 */
export class ReplayVersionMismatchError extends CycgraphError {
  constructor(
    public readonly runId: string,
    public readonly loggedVersion: unknown,
    public readonly currentVersion: number,
  ) {
    super(
      `Run ${runId} was recorded under replay version ${String(loggedVersion)}, and the reducers ` +
      `now implement version ${currentVersion}. Replaying it would reconstruct a state the ` +
      `original run never held, so any comparison against it would be meaningless.`,
    );
    this.name = 'ReplayVersionMismatchError';
  }
}

/**
 * The tail reached a node that touches the world, and neither a recording nor
 * an explicit opt-in covered it.
 *
 * Fails closed: a counterfactual that re-sends an email or re-charges a card
 * is worse than one that stops.
 */
export class SideEffectBlockedError extends CycgraphError {
  constructor(
    public readonly nodeId: string,
    public readonly nodeType: string,
    reason: string,
  ) {
    super(
      `Node '${nodeId}' (${nodeType}) would perform a real side effect in this fork: ${reason}. ` +
      `Either allow it explicitly with policy.sideEffects, or fork at a point where its inputs ` +
      `are unchanged so the recorded result can be replayed.`,
    );
    this.name = 'SideEffectBlockedError';
  }
}

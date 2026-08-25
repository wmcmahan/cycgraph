/**
 * Catalog: the set of workflows a studio session serves
 *
 * The studio is scenario-agnostic — nothing in it imports a workflow list.
 * Whoever starts it supplies a catalog: the playground passes its stress
 * registry, the studio CLI builds one from the user's config file, and both
 * can append ad-hoc file scenarios on top. Every picker, run verb, and
 * watcher tick resolves through the catalog it was given.
 *
 * @module scenarios/catalog
 */

import type { Scenario } from './types.js';
import { unmetRequirements, type Stack, type StackFeature } from '../stack/index.js';

/** The workflows one studio session serves, with lookup. */
export interface Catalog {
  scenarios: readonly Scenario[];
  find(id: string): Scenario | undefined;
}

/** Build a catalog over an explicit scenario list. */
export function catalogOf(scenarios: readonly Scenario[]): Catalog {
  return {
    scenarios,
    find: (id) => scenarios.find((entry) => entry.id === id),
  };
}

/** A scenario paired with whether this stack can run it. */
export interface ScenarioAvailability {
  scenario: Scenario;
  runnable: boolean;
  missing: StackFeature[];
}

/** Pair every catalog scenario with what the current stack is missing for it. */
export function availability(stack: Stack, catalog: Catalog): ScenarioAvailability[] {
  return catalog.scenarios.map((scenario) => {
    const missing = unmetRequirements(stack, scenario.requires);
    return { scenario, runnable: missing.length === 0, missing };
  });
}

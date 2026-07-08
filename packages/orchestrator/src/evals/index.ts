/**
 * Evals Module — Public API
 *
 * Explicit named re-exports (NOT `export *`) so a new symbol added to a leaf
 * file does NOT silently enter the package's public/semver surface.
 *
 * @module evals
 */

export type {
  EvalAssertion,
  AssertionResult,
  EvalCaseResult,
  EvalCase,
  EvalReport,
  EvalSuite,
} from './types.js';
export { checkAssertion } from './assertions.js';
export { runEval } from './runner.js';

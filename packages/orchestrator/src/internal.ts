/**
 * @cycgraph/orchestrator/internal — Unstable internal API
 *
 * Symbols here are implementation details of the engine. They are exposed
 * through the `@cycgraph/orchestrator/internal` subpath ONLY so first-party
 * tooling (benchmarks, advanced tests, custom adapters) can reach them — they
 * are **not** part of the package's semantic-versioning contract and may change
 * or disappear in any release without notice.
 *
 * If you're an application developer, import from `@cycgraph/orchestrator`
 * instead. If you find yourself needing something from here, that's usually a
 * signal the public API has a gap worth filing.
 *
 * @packageDocumentation
 */

// Runner-controlled lifecycle reducer (init/complete/fail/timeout/cancel/...).
// Public consumers should never dispatch these `_`-prefixed actions directly.
export { internalReducer } from './reducers/index.js';

// The token/event buffer GraphRunner manages internally for streaming.
export { StreamChannel } from './runner/stream-channel.js';

// filtrex-coupled condition internals. `evaluateCondition` stays public; these
// bind to filtrex's own surface and are exposed only for tooling/validation.
export {
  FILTREX_EXTRA_FUNCTIONS,
  FILTREX_COMPILE_OPTIONS,
  normalizeConditionExpression,
} from './utils/condition-expression.js';

// Low-level retry/backoff helpers.
export { calculateBackoff, sleep } from './runner/helpers.js';

/**
 * @cycgraph/orchestrator/internal — Internal API
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

export { internalReducer } from './state/reducers.js';

export { StreamChannel } from './execution/streaming/stream-channel.js';

export {
  FILTREX_EXTRA_FUNCTIONS,
  FILTREX_COMPILE_OPTIONS,
  normalizeConditionExpression,
} from './utils/condition-expression.js';

export { calculateBackoff, sleep } from './execution/engine/helpers.js';

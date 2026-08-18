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

// Counterfactual replay. Public `fork()` / `forkPoints()` land on the root
// barrel once the fork driver exists; these are the substrate underneath.
export {
  fork,
  forkEach,
  estimateSweep,
  estimateTailCost,
  formatEstimate,
  createChangeMiddleware,
  computeFingerprint,
  indexBaseRun,
  createMemoizer,
  change,
  snapshotPoints,
  loadSnapshotState,
  resolveForkSource,
  diffRuns,
  formatRunDiff,
  forkPoints,
  planForkPoint,
  replayEvents,
  resolveTarget,
  applyOverlays,
  createForkGuard,
  ChangeSchema,
  detectConflicts,
  describeChange,
  ForkError,
  ForkPointError,
  TargetError,
  OverlayError,
  ReplayVersionMismatchError,
  SideEffectBlockedError,
} from './replay/index.js';
export type {
  ReplayOptions,
  ReplayResult,
  ReplayStopContext,
  ReplayedAction,
  ForkPoint,
  ForkPointPlan,
  ForkPointSummary,
  ForkOptions,
  ForkResult,
  ForkEachOptions,
  ForkEachResult,
  VariantResult,
  TailEstimate,
  Memoizer,
  MemoEntry,
  MemoHit,
  FingerprintInput,
  ForkContext,
  ChangeInput,
  Change,
  ForkSource,
  ForkSourceKind,
  SnapshotPoint,
  ResolvedTarget,
  Overlays,
  RunDiff,
  DiffOptions,
  MemoryDelta,
  AlignedStep,
  ForkGuard,
  SideEffectPolicy,
  SuppressedEffect,
} from './replay/index.js';

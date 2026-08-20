/**
 * Counterfactual replay: fork a recorded run, change something, re-run only
 * what the change could affect.
 *
 * @module replay
 */

export { replayEvents } from './replay-events.js';
export type {
  ReplayOptions,
  ReplayResult,
  ReplayStopContext,
  ReplayedAction,
} from './replay-events.js';

export { planForkPoint, forkPoints, childForkPoints, ForkPointError } from './fork-point.js';
export { forkInChild, extractChildLog } from './fork-child.js';
export type { ChildForkOptions, ChildForkResult } from './fork-child.js';
export type { ForkPoint, ForkPointPlan, ForkPointSummary, ChildForkPointSummary } from './fork-point.js';

export { fork } from './fork.js';
export { forkEach, estimateSweep } from './fork-each.js';
export type { ForkEachOptions, ForkEachResult, VariantResult } from './fork-each.js';
export { estimateTailCost, formatEstimate } from './estimate.js';
export type { TailEstimate } from './estimate.js';
export { createChangeMiddleware, hasExecutionTimeChanges } from './change-middleware.js';
export type { ChangeMiddleware, AppliedChange } from './change-middleware.js';
export { resolveForkSource, snapshotPoints, loadSnapshotState } from './fork-source.js';
export type { ForkSource, ForkSourceKind, SnapshotPoint } from './fork-source.js';
export type { ForkOptions, ForkResult, ForkContext, ChangeInput } from './fork.js';

export { change, ChangeSchema, detectConflicts, describeChange } from './mutations.js';
export type { Change, HumanResponseChange } from './mutations.js';

export { resolveTarget, TargetError } from './target.js';
export type { ResolvedTarget } from './target.js';

export { applyOverlays, OverlayError } from './overlay.js';
export type { Overlays } from './overlay.js';

export { diffRuns, formatRunDiff } from './diff.js';
export type { RunDiff, DiffOptions, MemoryDelta, AlignedStep } from './diff.js';

export { canonicalJson, canonicalEquals } from './canonical.js';

export { computeFingerprint } from './fingerprint.js';
export type { FingerprintInput } from './fingerprint.js';

export { applyChanges, ApplyError } from './apply.js';
export type { AppliedChanges } from './apply.js';
export { indexBaseRun, createMemoizer } from './memoize.js';
export type { Memoizer, MemoEntry, MemoHit } from './memoize.js';

export { createForkGuard } from './fork-guard.js';
export type { ForkGuard, SideEffectPolicy, SuppressedEffect } from './fork-guard.js';

export { ForkError, ReplayVersionMismatchError, SideEffectBlockedError } from './errors.js';

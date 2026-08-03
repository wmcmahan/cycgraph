/**
 * Snapshot Builder
 *
 * Converts a `DriftReport` (the runtime view) into a `BaselineSnapshot`
 * (the persisted view). Keeping the conversion in one place means
 * writer/loader/compare can stay schema-stable while the runtime types
 * evolve.
 *
 * @module baseline/snapshot
 */

import type { DriftReport } from '../runner/types.js';
import {
  BASELINE_SCHEMA_VERSION,
  type BaselineSnapshot,
} from './types.js';

/** Inputs for building a `BaselineSnapshot` from a runtime drift report. */
export interface SnapshotInput {
  drift: DriftReport;
  driftCeiling: number;
  /** Short git SHA at capture time. */
  commit?: string;
  /** Run mode label (`local` / `ci`). */
  mode?: string;
  /** Override the generation timestamp (for deterministic tests). */
  now?: Date;
}

/** Build a `BaselineSnapshot` from the runtime drift report. */
export function snapshotFromDrift(input: SnapshotInput): BaselineSnapshot {
  const now = input.now ?? new Date();

  const suites: BaselineSnapshot['suites'] = {};
  for (const [name, summary] of Object.entries(input.drift.perSuite)) {
    suites[name] = {
      driftPercent: summary.driftPercent,
      totalTests: summary.totalTests,
      zodFailures: summary.zodFailures,
      semanticFailures: summary.semanticFailures,
      deterministicFailures: summary.deterministicFailures,
    };
  }

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    commit: input.commit,
    mode: input.mode,
    driftCeiling: input.driftCeiling,
    aggregateDrift: input.drift.aggregatePercent,
    passed: input.drift.passed,
    suites,
  };
}

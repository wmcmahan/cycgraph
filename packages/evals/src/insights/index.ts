/**
 * Telemetry insights
 *
 * Reads recorded runs and says what is wrong with them. Detection is
 * deterministic and offline: no model call, no forking, no network. What it
 * produces is a ranked list of findings, each carrying the evidence that
 * supports it and a statement of what a change would have to address.
 *
 * @module insights
 */

export type {
  TelemetryLogLine,
  TelemetryNodeUsage,
  TelemetryAssertion,
  RunTelemetry,
  TelemetryNodeTiming,
  Finding,
  FindingSeverity,
  Detector,
} from './types.js';

export { detectSignals } from './signals.js';
export { detectOutliers, computeMs } from './outliers.js';
export { detectAssertionFailures } from './assertions.js';
export { buildWorkflowProfile, describeLever } from './profile.js';
export type { WorkflowProfile, NodeProfile } from './profile.js';
export { buildInsightsReport, formatInsightsReport, DETECTORS } from './report.js';
export type { InsightsReport } from './report.js';

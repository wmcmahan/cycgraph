/**
 * Telemetry insights: shared shapes
 *
 * The detectors read a **normalised** view of a run rather than any one
 * producer's artifacts. The playground adapts its `.playground/runs/`
 * directories into it; a hosted control plane could adapt production
 * telemetry into the same shape without either side knowing about the other.
 *
 * @module insights/types
 */

/** One structured log line, as the engine's `LogSink` emitted it. */
export interface TelemetryLogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Dotted event name, e.g. `runner.node.agent.node_retry`. */
  event: string;
  context?: Record<string, unknown>;
}

/** Spend attributed to one node, as `WorkflowState.node_breakdown` records it. */
export interface TelemetryNodeUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

/** Execution time attributed to one node across a run. */
export interface TelemetryNodeTiming {
  /** Node type, which is what the node is rather than how it performed. */
  type: string;
  total_ms: number;
  visits: number;
}

/** What one assertion concluded about a run. */
export interface TelemetryAssertion {
  type: string;
  passed: boolean;
  message?: string;
}

/** One recorded run, in the shape every detector reads. */
export interface RunTelemetry {
  runId: string;
  /** The workflow this run is an instance of — scenario id, graph id, name. */
  workflow: string;
  /** Terminal status: `completed`, `failed`, `waiting`, … */
  status: string;
  /**
   * Wall clock, which is not what the workflow did.
   *
   * A run pauses for approvals, waits on remote agents, and resumes later, and
   * all of that is in here. One recorded run shows 31 seconds of wall clock
   * against 4 milliseconds of node execution. Kept because it is what a person
   * waited, and deliberately not read by any detector.
   */
  durationMs?: number;
  /** Wall-clock start, for ordering and windowing. */
  startedAt?: string;
  logs: TelemetryLogLine[];
  totalTokens: number;
  /**
   * Per-node spend. Absent on many runs — a detector must degrade to
   * run-level rather than assume attribution exists.
   */
  byNode?: Record<string, TelemetryNodeUsage>;
  /**
   * The inputs this run was given.
   *
   * Two runs of one workflow under different parameters can do different
   * amounts of work, so they are different populations and pooling their
   * timings describes neither.
   */
  params?: Record<string, unknown>;
  /** Model the run resolved through. Token and duration counts are per model. */
  model?: string;
  assertions: TelemetryAssertion[];
  /**
   * Execution time and visit count per node.
   *
   * The detectors' notion of how long something took. Summing it gives the
   * time the run spent executing, which is the part a change can affect.
   */
  nodeTiming?: Record<string, TelemetryNodeTiming>;
  /** Nodes the run visited, in order. */
  visitedNodes?: string[];
}

/** How much a finding is worth someone's attention. */
export type FindingSeverity = 'high' | 'medium' | 'low';

/** Something worth looking at, found in telemetry. */
export interface Finding {
  /**
   * Stable across detection passes, so a finding can be tracked, suppressed,
   * or matched to a hypothesis already tested. Derived from what the finding
   * is about, never from when it was found.
   */
  id: string;
  /** Which detector produced it. */
  detector: string;
  severity: FindingSeverity;
  /** The workflow it concerns, or `'*'` when it spans several. */
  workflow: string;
  /** The node it concerns, when the signal is node-attributed. */
  nodeId?: string;
  /** One line, phrased as what is happening rather than what to do. */
  title: string;
  /** What the numbers are, for a reader deciding whether to care. */
  detail: string;
  evidence: {
    /** Runs exhibiting it. */
    runs: number;
    /** Total occurrences, which can exceed `runs`. */
    occurrences: number;
    /** Runs it exhibits in, capped — enough to fork, not the whole list. */
    sampleRunIds: string[];
    /** Runs examined, so a rate is readable rather than a bare count. */
    of: number;
    /**
     * When the most recent run exhibiting it started.
     *
     * A finding whose newest evidence is days old was probably fixed since,
     * and reporting it as though it were current wastes the reader.
     */
    lastSeen?: string;
  };
  /**
   * What a change would have to address, phrased for the hypothesis step.
   *
   * Deliberately not a proposed change: detection states the problem, and the
   * hypothesis step turns it into a `change.*` spec that a fork can test.
   */
  addresses: string;
}

/** A detector: pure, deterministic, over the whole corpus at once. */
export type Detector = (runs: readonly RunTelemetry[]) => Finding[];

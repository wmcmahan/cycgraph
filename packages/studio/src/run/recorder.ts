/**
 * Run recorder
 *
 * Every run writes an artifact directory. Comparing two runs, rendering a
 * history table, and anything a dashboard shows all read these files, which is
 * why they exist before any front end does.
 *
 * ```
 * .playground/runs/<scenarioId>-<runId>/
 *   meta.json       scenario, params, stack, trace id, timing, status
 *   events.ndjson   every StreamEvent
 *   logs.ndjson     every LogEntry
 *   state/NNN.json  a state snapshot per applied action
 *   usage.json      tokens and cost
 *   evals.json      assertion results
 *   notes.json      scenario-specific facts, when a scenario records any
 * ```
 *
 * @module run/recorder
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { AssertionResult, LogEntry, StreamEvent, WorkflowState } from '@cycgraph/orchestrator';
import type { StackConfig } from '../stack/index.js';

/** Header written once per run, and the row a history table reads. */
export interface RunMeta {
  runId: string;
  scenarioId: string;
  params: unknown;
  stack: StackConfig;
  /** Jaeger trace id, when tracing is on. */
  traceId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Terminal workflow status, or `crashed` when the run threw. */
  status?: string;
  error?: string;
  /**
   * The run this one forked, when it is a counterfactual.
   *
   * A fork is a run of this scenario like any other and leaves the same
   * artifacts, so history reads it the same way. This is what lets the listing
   * nest it under what it forked rather than stranding it as an unexplained
   * sibling that happens to share a scenario.
   */
  parentRunId?: string;
  /** Where in the parent the fork diverged. */
  forkSequenceId?: number;
  /**
   * True when the fork served its tail from the recording instead of running
   * it. A memoized fork's timings measure nothing, so a reader comparing
   * costs must be able to exclude them — and absence of the field means the
   * run predates its recording, which excludes it just as hard.
   */
  forkMemoized?: boolean;
  /** Ledger ids of the applied proposals this run executed under. */
  appliedProposals?: string[];
  /** True when the artifacts were reconstructed from the event log. */
  imported?: boolean;
  /**
   * The applied proposals' changes, verbatim.
   *
   * Self-contained rather than a reference, because a fork of this run must
   * rebuild the same effective configuration even if the ledger has moved on
   * — the run is the record of what actually executed.
   */
  appliedChanges?: unknown[];
  /** What the fork changed, in wire form. */
  forkChanges?: unknown[];
  /**
   * Present when the fork diverged INSIDE a subgraph child of the parent.
   *
   * The artifact's primary run is the parent continuation; the child
   * variant's identity lives here so tooling can tell a mid-child draw from
   * a plain fork at the same parent boundary.
   */
  forkChild?: {
    subgraphNodeId: string;
    childBaseRunId: string;
    childVariantRunId: string;
    childStatus: string;
    parentSkipped?: string;
  };
}

/** Token and cost totals, read off the final state. */
export interface RunUsage {
  totalTokens: number;
  totalCostUsd: number;
  nodesVisited: number;
  /** Spend attributed to the node that incurred it. */
  byNode?: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number; calls: number }>;
}

/**
 * Collects one run's artifacts.
 *
 * Writes are append-as-you-go rather than buffered to the end, so a run that
 * crashes or is killed still leaves everything it produced up to that point.
 * That matters directly: the crash scenarios kill the process on purpose.
 */
export class RunRecorder {
  readonly dir: string;
  private readonly events: WriteStream;
  private readonly logs: WriteStream;
  private meta: RunMeta;
  private stateIndex = 0;
  private closed = false;

  private constructor(dir: string, meta: RunMeta) {
    this.dir = dir;
    this.meta = meta;
    this.events = createWriteStream(join(dir, 'events.ndjson'), { flags: 'a' });
    this.logs = createWriteStream(join(dir, 'logs.ndjson'), { flags: 'a' });
  }

  /** Create the artifact directory and write the initial `meta.json`. */
  static async open(
    artifactRoot: string,
    meta: Omit<RunMeta, 'startedAt'>,
  ): Promise<RunRecorder> {
    const dir = join(artifactRoot, 'runs', `${meta.scenarioId}-${meta.runId}`);
    await mkdir(join(dir, 'state'), { recursive: true });

    const recorder = new RunRecorder(dir, { ...meta, startedAt: new Date().toISOString() });
    await recorder.flushMeta();
    return recorder;
  }

  /** Record a stream event. */
  async event(event: StreamEvent): Promise<void> {
    this.events.write(`${JSON.stringify(event)}\n`);
  }

  /**
   * Record a structured log line.
   *
   * Wired through `LogSink`, which receives every entry the engine would
   * otherwise write to a process stream, after level filtering.
   *
   * A scenario writing its own line by hand builds the entry itself and so
   * arrives without correlation ids. Stamping the ones already present is what
   * keeps every line in the file joinable to the trace, not only the engine's.
   */
  log(entry: LogEntry): void {
    if (this.closed) return;

    const spanContext = trace.getActiveSpan()?.spanContext();
    const correlated = entry.trace_id === undefined && spanContext && isSpanContextValid(spanContext)
      ? { ...entry, trace_id: spanContext.traceId, span_id: spanContext.spanId }
      : entry;

    this.logs.write(`${JSON.stringify(correlated)}\n`);
  }

  /**
   * Snapshot state under a monotonic index.
   *
   * Driven from the runner's `persistState` hook rather than from the event
   * stream: `action:applied` and the other non-terminal events deliberately
   * carry no state, so the stream alone cannot produce a timeline.
   */
  async snapshot(state: WorkflowState): Promise<void> {
    const name = String(this.stateIndex++).padStart(3, '0');
    await writeFile(join(this.dir, 'state', `${name}.json`), JSON.stringify(state, null, 2));
  }

  /** Attach the trace id once the root span exists. */
  async setTraceId(traceId: string): Promise<void> {
    this.meta = { ...this.meta, traceId };
    await this.flushMeta();
  }

  /** Scenario-specific facts, for outcomes the standard files cannot express. */
  async writeNotes(notes: Record<string, unknown>): Promise<void> {
    await writeFile(join(this.dir, 'notes.json'), JSON.stringify(notes, null, 2));
  }

  /**
   * Add to `meta.json` after the run has started.
   *
   * Some header facts are only known once the run resolves — where a fork
   * diverged, for one — and the recorder has to be open before that to capture
   * the logs.
   */
  async amendMeta(fields: Partial<RunMeta>): Promise<void> {
    this.meta = { ...this.meta, ...fields };
    await this.flushMeta();
  }

  async writeUsage(usage: RunUsage): Promise<void> {
    await writeFile(join(this.dir, 'usage.json'), JSON.stringify(usage, null, 2));
  }

  async writeEvals(results: AssertionResult[]): Promise<void> {
    await writeFile(join(this.dir, 'evals.json'), JSON.stringify(results, null, 2));
  }

  /**
   * Finalise `meta.json` and close the append streams.
   *
   * `durationMs` is measured from `open()` unless the caller states it. A fork
   * records itself after the fact — its runner is owned by `fork()`, which
   * mints the run id the recorder needs — so measuring here would report the
   * time spent writing artifacts rather than the time spent running.
   */
  async close(outcome: { status: string; error?: string; durationMs?: number }): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const endedAt = new Date().toISOString();
    this.meta = {
      ...this.meta,
      endedAt,
      durationMs: outcome.durationMs ?? Date.parse(endedAt) - Date.parse(this.meta.startedAt),
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    await this.flushMeta();

    await Promise.all([
      new Promise<void>((resolve) => this.events.end(resolve)),
      new Promise<void>((resolve) => this.logs.end(resolve)),
    ]);
  }

  private async flushMeta(): Promise<void> {
    await writeFile(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2));
  }
}

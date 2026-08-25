/**
 * Scenario contract
 *
 * A scenario is a parameterised graph plus the wiring it needs. Its knobs are
 * a Zod schema, which the CLI renders as flags and the dashboard renders as a
 * form, so a sweep is a loop over that one declaration rather than a third
 * hand-maintained list.
 *
 * @module scenarios/types
 */

import type { z } from 'zod';
import type {
  EvalAssertion,
  Graph,
  GraphRunnerOptions,
  HumanResponse,
  RunInput,
  StreamEvent,
  WorkflowState,
} from '@cycgraph/orchestrator';
import type { RunRecorder } from '../run/recorder.js';
import type { Stack, StackFeature } from '../stack/index.js';

/**
 * What a scenario's `build()` hands back.
 *
 * Wiring is explicit rather than inferred from inline `agent()` values,
 * because the playground drives `GraphRunner.stream()` directly and the stack
 * owns the registries. `run()` builds that closure itself and would reject a
 * caller-supplied registry.
 */
export interface ScenarioBuild {
  graph: Graph;
  input: RunInput;
  runner: Partial<GraphRunnerOptions>;
  /**
   * Answers an approval gate or a remote `input-required` pause. Scenarios
   * that script their own answer stay non-interactive, which is what makes
   * them sweepable; without one the CLI prompts.
   */
  hitl?: (question: string) => Promise<HumanResponse>;
  /**
   * Abort the run this many milliseconds in.
   *
   * Cancellation arrives from outside the graph, so it cannot be expressed as
   * a node: the driver holds the signal and the runner observes it mid-flight.
   */
  abortAfterMs?: number;
}

/** What a self-driving scenario reports back. */
export interface DriveResult {
  /** Terminal status, as the default driver would report it. */
  status: string;
  finalState?: WorkflowState;
  error?: string;
  /** Scenario-specific facts, written to the artifacts for comparison. */
  notes?: Record<string, unknown>;
}

/** What a self-driving scenario is handed. */
export interface DriveContext {
  runId: string;
  /** Same recorder the default driver uses, so artifacts stay uniform. */
  recorder: RunRecorder;
  /**
   * W3C propagation fields for the run's span.
   *
   * Pass these into the environment of any process the scenario spawns, and
   * have that process run its work inside `withRemoteTraceContext`. Without
   * it a worker's spans form their own trace, which for a scenario whose
   * whole subject is a worker dying is the trace nobody can find.
   */
  traceContext: Record<string, string>;
  onProgress?: (event: StreamEvent) => void;
}

/** A parameterised, runnable stress scenario. */
export interface Scenario<P extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Stable id. Used as the CLI argument and the artifact directory prefix. */
  id: string;
  /**
   * File this workflow was loaded from, when it came from one.
   *
   * The editor uses it to skip searching: a config already says where a
   * workflow is defined, and guessing from a name match is how an edit
   * lands in a test that merely mentions it.
   */
  sourcePath?: string;
  /** One-line title for the picker. */
  title: string;
  /** Engine surfaces this puts under load, for filtering and for the README. */
  covers: readonly string[];
  /** Infrastructure it cannot run without. */
  requires: readonly StackFeature[];
  /** Tweakable knobs. The single source of truth for flags and form fields. */
  params: P;
  /** Turn parameters plus resolved infrastructure into a runnable graph. */
  build(params: z.infer<P>, stack: Stack): Promise<ScenarioBuild>;
  /**
   * Drive the run instead of the default stream loop.
   *
   * For scenarios where the runner itself is the subject: a worker that gets
   * killed mid-run, two workers racing one claim. The default driver streams
   * a `GraphRunner` in this process, which cannot express a run whose executor
   * is supposed to die. Artifacts are recorded the same either way.
   */
  drive?(params: z.infer<P>, stack: Stack, ctx: DriveContext): Promise<DriveResult>;
  /**
   * Checked after each run. A failure is recorded, never thrown.
   *
   * Receives the stack because what should be asserted can depend on what is
   * behind the run: a cost ceiling cannot be breached by a model that is free,
   * so the expected outcome follows the infrastructure, not only the knobs.
   */
  evals?(params: z.infer<P>, stack: Stack): EvalAssertion[];
}

/**
 * Declare a scenario.
 *
 * Exists to infer `P` at the call site, so `build` and `evals` receive
 * fully-typed parameters without the author restating the schema type.
 */
export function scenario<P extends z.ZodTypeAny>(spec: Scenario<P>): Scenario<P> {
  return spec;
}

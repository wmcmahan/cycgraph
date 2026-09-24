/**
 * What a maintenance workflow is, in engine vocabulary.
 *
 * No harness assumed: a workflow declares its knobs, builds a graph from
 * them plus the environment it is handed, and states its objective as
 * eval assertions. The playground catalog, a CI runner, and a bare
 * script can all run one; adapting to a harness's own contract is that
 * harness's wrapper's job, never this package's.
 *
 * @module maintenance/types
 */

import type { z } from 'zod';
import type { EvalAssertion, Graph, GraphRunnerOptions } from '@cycgraph/orchestrator';
import type { PublishConfig } from '@cycgraph/tools/git';
import type { AuditSchedule } from './repo-audit/schedule.js';
import type { MaintenanceContext } from './shared/context.js';
import type { RunProvenance } from './shared/provenance.js';

/** The environment a maintenance workflow needs from whatever runs it. */
export interface MaintenanceEnv {
  model: string;
  provider: string;
  /**
   * Per-tier model overrides. Agents resolve their capability tier through
   * `modelFor`, which falls back to `model` for any missing tier, so a
   * single-model environment runs everything on `model` unchanged.
   */
  models?: { high?: string; medium?: string; low?: string };
  /** Credentials and commit identity for the delivery tail. */
  publish?: PublishConfig;
  /**
   * Cross-run lesson memory is wired for this run. When true, a workflow
   * may add `memoryQuery` directives and a reflection node; when absent it
   * must build the exact graph it builds without memory — a reflection
   * node with no writer injected fails the run at execution.
   */
  memory?: boolean;
  /**
   * Reader for the audit patrol's scheduler state, wired when lesson
   * memory is. Absent, charter ordering degrades to the stateless
   * diagonal — the same slice every run, rotated only by `skip`.
   */
  auditSchedule?: { load(): Promise<AuditSchedule | undefined> };
  /**
   * Repository-shaped settings the workflows read (labels, standards,
   * layout). Absent means this repository's own defaults, resolved once
   * through {@link contextOf}, so a run that supplies no context behaves
   * exactly as before the seam existed.
   */
  context?: MaintenanceContext;
  /**
   * The run this build executes as, fixed before the graph runs so the
   * comments a workflow posts can name it. Absent for a build made
   * outside the harness.
   */
  provenance?: RunProvenance;
}

/** What a build hands the runner. */
export interface MaintenanceBuild {
  graph: Graph;
  input: { goal: string; maxIterations?: number; maxTokenBudget?: number };
  runner: Partial<GraphRunnerOptions>;
  /**
   * Cleanup for a run that died on an engine-level throw (token budget
   * exhaustion, a fatal provider error) — a death the graph's own
   * failure-handling nodes never see. The harness calls it before
   * exiting nonzero; the returned line, if any, is printed for the
   * operator. Implementations must swallow their own errors: cleanup
   * failing must not mask the error that killed the run.
   */
  onFatal?: (error: unknown) => Promise<string | undefined>;
}

/** A maintenance workflow: knobs, build, and objective. */
export interface MaintenanceWorkflow<P extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  title: string;
  covers: readonly string[];
  /**
   * Infrastructure the workflow cannot run without, in the harness's
   * feature vocabulary. Absent means a model is needed; a workflow with
   * no model (a purely mechanical one) declares `[]`.
   */
  requires?: readonly string[];
  params: P;
  build(params: z.infer<P>, env: MaintenanceEnv): Promise<MaintenanceBuild>;
  evals(): EvalAssertion[];
}

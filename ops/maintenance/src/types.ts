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

/** The environment a maintenance workflow needs from whatever runs it. */
export interface MaintenanceEnv {
  model: string;
  provider: string;
  /** Credentials and commit identity for the delivery tail. */
  publish?: PublishConfig;
}

/** What a build hands the runner. */
export interface MaintenanceBuild {
  graph: Graph;
  input: { goal: string; maxIterations?: number; maxTokenBudget?: number };
  runner: Partial<GraphRunnerOptions>;
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

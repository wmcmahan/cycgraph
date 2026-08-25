/**
 * @cycgraph/studio — debug, improve, and monitor cycgraph runs
 *
 * The scenario-agnostic core behind the dashboard and the playground: the
 * server and UI, stack resolution, the run driver and its artifacts, fork
 * and counterfactual machinery, the tune/improve ladder, and the CLI. A
 * host supplies the catalog of workflows; the studio supplies every verb
 * over them.
 *
 * @module index
 */

// ── The workflow contract and catalogs ──
export { scenario } from './scenarios/types.js';
export type { Scenario, ScenarioBuild, DriveContext, DriveResult } from './scenarios/types.js';
export { catalogOf, availability } from './scenarios/catalog.js';
// Generic plumbing a host's own maintenance workflow needs: clone, edit,
// commit, and print the publish script. The workflows themselves belong to
// whoever owns the repository, not to the studio.
export { cloneToBranch, commit, pendingDiff, publishScript, changedIn } from './maintenance/branch.js';
export type { Branch } from './maintenance/branch.js';
export type { Catalog, ScenarioAvailability } from './scenarios/catalog.js';
export { loadScenarioFile, looksLikeScenarioFile, bundleScenario, ScenarioLoadError } from './scenarios/loader.js';
export { loadStudioConfig, catalogFromConfig, stackDefaultsFrom, StudioConfigSchema, StudioConfigError } from './config.js';
export type { StudioConfig, LoadedStudioConfig } from './config.js';

// ── The stack ──
export {
  defaultStackConfig,
  resolveStack,
  isLocalModel,
  providerFor,
  providersFor,
  unmetRequirements,
} from './stack/index.js';
export type { Stack, StackConfig, StackFeature } from './stack/index.js';
export { MCP_SERVER_ID } from './stack/servers.js';

// ── Running and recording ──
export { executeScenario } from './run/execute.js';
export { findRun, loadHistory, loadRunLogs, isClean } from './run/history.js';
export type { HistoryEntry } from './run/history.js';
export { inspectRuns, profileWorkflow } from './run/insights.js';
export { importRun, importAll } from './run/import.js';
export type { ImportOutcome } from './run/import.js';

// ── Counterfactuals ──
export { forkRecordedRun, forkPointsForRun, checkForkConformance } from './run/fork.js';

// ── The improvement ladder ──
export { tuneWorkflow } from './improve/tune.js';
export { improveScenario, improveWorkflow, improveTuneTargetFor } from './improve/improve.js';
export type { ImproveOptions } from './improve/improve.js';
export {
  findProposal,
  listProposals,
  readEpoch,
  saveProposals,
  setProposalStatus,
  trialChangesFor,
  writeEpoch,
} from './improve/proposals.js';
export { applyProposal, resolveApplyRepo } from './improve/apply.js';
export { editInWorkspace, editorGraph, verifyBuilt } from './improve/editor.js';
export { workspaceDiff, createWorkspace, prCommand } from './improve/workspace.js';
export { refreshFixtureRepo } from './improve/fixture.js';
export { loadTicks, watchTick, workflowReadiness } from './improve/watch.js';
export { runImproveLoop } from './improve/loop.js';
export type { LoopAutonomy, LoopEvent, LoopOptions, LoopResult } from './improve/loop.js';
export { createLoopController } from './server/loop.js';
export type { LoopController, LoopStatus } from './server/loop.js';
export type { WorkflowReadiness } from './improve/watch.js';

// ── The dashboard ──
export { createDashboard, startDashboard } from './server/index.js';
export type { Dashboard } from './server/index.js';
export { createWatcher } from './server/watcher.js';
export type { Watcher, WatcherOptions } from './server/watcher.js';
export { createBus } from './server/bus.js';
export type { Bus } from './server/bus.js';

// ── The CLI, as a harness the host parameterizes ──
export { runCli, runCliMain } from './cli/main.js';
export type { CliHarness, CliContext } from './cli/main.js';
export { renderStack, renderForkConformance } from './cli/render.js';

// ── Params introspection (schema-driven forms and flags) ──
export { describeParams } from './params/introspect.js';
export { parseFlags, FlagError } from './cli/flags.js';
export { assembleParams, displayValue, parseValue } from './params/form.js';
export type { FormField } from './params/form.js';

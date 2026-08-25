/**
 * The improve workflow: the proposal ladder as a recorded run
 *
 * Stage B of the improve-graph decomposition (`docs/plans/improve-graph.md`).
 * The parent graph composes what the discrete CLI commands do — tune, save,
 * trial, apply, merged — with the human decisions as approval nodes, so one
 * guided session walks a proposal as far up the ladder as its reviewer
 * wants. Every rung writes through the same ledger the discrete commands
 * use, so a session that stops at any gate leaves state the standalone
 * commands can pick up later: reject the trial gate and `play apply` still
 * works tomorrow; approve everything and the epoch is recorded in one
 * sitting.
 *
 * The boundary rule, applied: the pure decision rules stay in
 * `@cycgraph/evals` and `tune-plan.ts`; the parent graph carries the gates
 * and the durability of running the ladder as a recorded, resumable,
 * forkable run. Both intelligent stages are true subgraphs by default: the
 * tune graph (sense, then the plan-measure-decide cycle, with the measure
 * fan-out a subgraph inside it) and the fix-loop editor between the apply
 * and merged gates, its workspace tools bound at build time to a clone
 * path that a `clone` tool node materializes once the gate approves. A
 * provided driver (`drivers.tune`, `drivers.apply`) collapses its stage to
 * a single tool node — the slot a hosted or headless implementation plugs
 * into, and what the run-path tests stub.
 *
 * The run records under its own scenario id, never the target's, so the
 * improve pass is not an observation of the workflow it improves.
 *
 * @module improve/improve
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { approval, graph, node, subgraph, tool } from '@cycgraph/orchestrator';
import { executeScenario } from '../run/execute.js';
import type { ExecuteOptions, RunOutcome } from '../run/execute.js';
import { buildTuneGraph } from './tune.js';
import type { TuneOptions, TuneOutcome } from './tune.js';
import {
  findProposal,
  saveProposals,
  setProposalStatus,
  writeEpoch,
} from './proposals.js';
import {
  branchNameFor,
  changedFiles,
  commitWorkspace,
  createWorkspace,
  prCommand,
  verifyWorkspace,
  workspaceDiff,
} from './workspace.js';
import { editorGraph, editInstructionFor, MAX_EDIT_ITERATIONS } from './editor.js';
import { scenario } from '../scenarios/types.js';
import type { Catalog } from '../scenarios/catalog.js';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';

/** The scenario id improve runs record under. */
export const IMPROVE_SCENARIO_ID = 'improve';

/** What the apply rung's driver returns: where the change now lives. */
export interface ApplyResult {
  branch: string;
  workspace: string;
  files: string[];
  prCommand: string;
}

/**
 * The stages a session can swap out.
 *
 * This is the composition seam the plan's slot criteria describe: the ladder
 * upstream neither knows nor cares whether measurement runs locally or the
 * editor is the in-process fix-loop, a hosted service, or a headless coding
 * agent — a driver returns the same shape either way. It is also what makes
 * the ladder testable against the real engine without cloning anything.
 */
export interface ImproveDrivers {
  /** Measures the target workflow and returns what the pass concluded. */
  tune: () => Promise<TuneOutcome>;
  /** Writes one proposal into a source branch and returns where it landed. */
  apply: (record: NonNullable<Awaited<ReturnType<typeof findProposal>>>) => Promise<ApplyResult>;
}

/** How to run an improve session. */
export interface ImproveOptions {
  /** Passed through to the measurement pass. */
  tune?: TuneOptions;
  /** Repository the apply rung clones. */
  repoRoot: string;
  /** Driver-level narration: fork progress, editor progress, rung outcomes. */
  onProgress?: (message: string) => void;
  /** Stream events from the improve run itself, for terminal rendering. */
  onEvent?: ExecuteOptions['onProgress'];
  /** Answers the gates. Required, because the gates are the point. */
  hitl: ExecuteOptions['hitl'];
  /** Stage overrides; anything omitted runs the built-in driver. */
  drivers?: Partial<ImproveDrivers>;
  /**
   * Pin the editor's workspace path instead of minting one.
   *
   * A rebuild is only faithful to a recorded session when its workspace
   * tools are jailed to the SAME clone the session edited, so forking a
   * recorded improve run passes the original path here.
   */
  workspaceAt?: string;
}

/** What the record rung wrote, carried between rungs in memory. */
interface RecordResult {
  count: number;
  ids: string[];
  first?: { id: string; workflow: string; nodeId: string; knob: string };
}

/**
 * Build the improve graph for one target workflow.
 *
 * Exported for inspection and tests; `improveWorkflow` is the entry point.
 * The graph is built fresh per session because its tools close over the
 * target scenario, its parameters, and the stack.
 */
export function buildImproveGraph(
  target: Scenario,
  targetParams: unknown,
  stack: Stack,
  options: ImproveOptions,
) {
  const artifactRoot = stack.config.artifactRoot;
  const say = (message: string) => options.onProgress?.(message);

  const firstOf = (args: Record<string, unknown>): { id: string } => {
    const record = args['record_result'] as RecordResult | undefined;
    if (!record?.first) throw new Error('no proposal on the ladder');
    return record.first;
  };

  const tuneOptions = { ...(options.tune ?? {}), onProgress: (line: string) => say(line) };

  const recordProposals = tool({
    name: 'record_proposals',
    description: 'Persist winning proposals to the ledger.',
    parameters: z.object({ tune_result: z.unknown().optional() }),
    execute: async (args): Promise<RecordResult> => {
      const outcome = args.tune_result as TuneOutcome;
      const ids = await saveProposals(artifactRoot, outcome);
      const first = ids[0] ? await findProposal(artifactRoot, ids[0]) : undefined;
      if (ids.length === 0) say('no proposals: every sweep said keep');
      if (first) {
        say(`proposal ${first.id}: ${first.nodeId}.${first.knob} ${String(first.from)} → ${String(first.to)}`);
        if (ids.length > 1) say(`${ids.length - 1} more remain at proposed for \`play apply\``);
      }
      return {
        count: ids.length,
        ids,
        ...(first
          ? { first: { id: first.id, workflow: first.workflow, nodeId: first.nodeId, knob: first.knob } }
          : {}),
      };
    },
  });

  const stampTrial = tool({
    name: 'stamp_trial',
    description: 'Move the proposal to trial, so ordinary runs execute under it.',
    parameters: z.object({ record_result: z.unknown().optional() }),
    execute: async (args) => {
      const { id } = firstOf(args);
      const result = await setProposalStatus(artifactRoot, id, 'trial');
      if ('error' in result) throw new Error(result.error);
      say(`${id} → trial`);
      return { id, status: 'trial' };
    },
  });

  const applyToSource = tool({
    name: 'apply_to_source',
    description: 'Clone, edit, verify, commit: write the proposal into source on a branch.',
    parameters: z.object({ record_result: z.unknown().optional() }),
    timeoutMs: 0,
    execute: async (args) => {
      const { id } = firstOf(args);
      const record = await findProposal(artifactRoot, id);
      if (!record) throw new Error(`proposal ${id} disappeared from the ledger`);

      const applied = await options.drivers!.apply!(record);
      await setProposalStatus(artifactRoot, id, 'pr', {
        branch: applied.branch,
        workspace: applied.workspace,
        prCommand: applied.prCommand,
      });
      say(`${id} → pr`);
      say(`to open the PR:\n    ${applied.prCommand}`);

      return { id, branch: applied.branch, files: applied.files, prCommand: applied.prCommand };
    },
  });

  const stampMerged = tool({
    name: 'stamp_merged',
    description: 'Mark the proposal applied and record the corpus epoch.',
    parameters: z.object({ record_result: z.unknown().optional() }),
    execute: async (args) => {
      const { id } = firstOf(args);
      const result = await setProposalStatus(artifactRoot, id, 'applied');
      if ('error' in result) throw new Error(result.error);
      await writeEpoch(artifactRoot);
      say(`${id} → applied (corpus epoch recorded)`);
      return { id, status: 'applied', epoch: true };
    },
  });

  const reportOutcome = tool({
    name: 'report_outcome',
    description: 'Report where the ladder stopped.',
    parameters: z.object({ record_result: z.unknown().optional() }),
    execute: async (args) => {
      const record = args.record_result as RecordResult | undefined;
      if (!record?.first) return { outcome: 'nothing to carry: no proposals' };
      const current = await findProposal(artifactRoot, record.first.id);
      const status = current?.status ?? 'unknown';
      say(`${record.first.id} stays at ${status}`);
      return { outcome: `left at ${status}`, id: record.first.id };
    },
  });

  // The tune stage: a provided driver collapses it to one tool node; the
  // default embeds the tune graph as a subgraph, so the session's log holds
  // the whole cycle — plan, the measure fan-out, decide — as child events.
  // Both shapes land the outcome under 'tune_result'.
  const tuneNode = options.drivers?.tune
    ? node({
      id: 'tune',
      type: 'tool',
      toolId: 'run_tune',
      tools: [tool({
        name: 'run_tune',
        description: 'Measure the target workflow: enumerate knobs, fork every arm, decide.',
        parameters: z.object({}),
        timeoutMs: 0,
        execute: (): Promise<TuneOutcome> => options.drivers!.tune!(),
      })],
      reads: [],
    })
    : subgraph(buildTuneGraph(target, targetParams, stack, undefined, tuneOptions), {
      id: 'tune',
      reads: [],
      outputs: { tune_result: 'tune_result' },
      maxIterations: 500,
    });
  const recordNode = node({
    id: 'record',
    type: 'tool',
    toolId: 'record_proposals',
    tools: [recordProposals],
    reads: ['tune_result'],
  });
  const leave = node({
    id: 'leave',
    type: 'tool',
    toolId: 'report_outcome',
    tools: [reportOutcome],
    reads: [recordNode.result],
  });
  const trialNode = node({
    id: 'trial',
    type: 'tool',
    toolId: 'stamp_trial',
    tools: [stampTrial],
    reads: [recordNode.result],
  });
  const mergedNode = node({
    id: 'merged',
    type: 'tool',
    toolId: 'stamp_merged',
    tools: [stampMerged],
    reads: [recordNode.result],
  });

  const gateTrial = approval({
    id: 'gate_trial',
    prompt: 'Trial the top proposal? While on trial, ordinary runs of the workflow execute under its change and accrue evidence.',
    reviewKeys: [recordNode.result],
    onReject: leave,
  });
  const gateApply = approval({
    id: 'gate_apply',
    prompt: 'Write the change into source? A clone is edited, verified, and committed to a branch. Reject to leave it in trial and return later with `play apply`.',
    reviewKeys: [recordNode.result],
    onReject: leave,
  });
  // The apply stage: a provided driver collapses it to one tool node (the
  // hosted/headless editor slot); the default embeds the fix-loop editor as
  // a subgraph, its workspace tools bound to a clone path chosen here and
  // materialized by the clone node once the gate approves.
  const stage = options.drivers?.apply
    ? (() => {
      const applyNode = node({
        id: 'apply',
        type: 'tool',
        toolId: 'apply_to_source',
        tools: [applyToSource],
        reads: [recordNode.result],
      });
      return { nodes: [applyNode], edges: [], entry: applyNode, resultKey: applyNode.result };
    })()
    : (() => {
      const wsRoot = options.workspaceAt ?? join(tmpdir(), `cycgraph-ws-improve-${randomUUID()}`);
      const child = editorGraph(stack, wsRoot);

      const briefTool = tool({
        name: 'edit_brief',
        description: 'Compose the editing instruction the proposal implies.',
        parameters: z.object({ record_result: z.unknown().optional() }),
        execute: async (args) => {
          const { id } = firstOf(args);
          const record = await findProposal(artifactRoot, id);
          if (!record) throw new Error(`proposal ${id} disappeared from the ledger`);
          return editInstructionFor(record);
        },
      });
      const cloneTool = tool({
        name: 'clone_workspace',
        description: 'Clone the repository into the workspace the editor is jailed to.',
        parameters: z.object({ record_result: z.unknown().optional() }),
        timeoutMs: 0,
        execute: async (args) => {
          const { id } = firstOf(args);
          const record = await findProposal(artifactRoot, id);
          if (!record) throw new Error(`proposal ${id} disappeared from the ledger`);
          const ws = await createWorkspace(options.repoRoot, record, { at: wsRoot });
          say(`workspace ${ws.root} on ${ws.branch}`);
          return { root: ws.root, branch: ws.branch };
        },
      });
      const shipTool = tool({
        name: 'ship_workspace',
        description: 'Verify the edited workspace, commit it, and prepare the PR command.',
        parameters: z.object({ record_result: z.unknown().optional(), clone_result: z.unknown().optional() }),
        timeoutMs: 0,
        execute: async (args) => {
          const { id } = firstOf(args);
          const record = await findProposal(artifactRoot, id);
          if (!record) throw new Error(`proposal ${id} disappeared from the ledger`);
          const ws = { root: wsRoot, branch: branchNameFor(record) };

          const files = await changedFiles(ws);
          if (files.length === 0) throw new Error('the editor changed nothing — no branch was made');
          say(`changed: ${files.join(', ')}`);

          const failure = await verifyWorkspace(ws, stack, record.workflow, record.change);
          if (failure) throw new Error(`verification failed: ${failure}`);
          say('verified: rebuild carries the proposed values; typecheck clean');

          await commitWorkspace(ws, record);
          const command = prCommand(ws, record, options.repoRoot);
          const diff = await workspaceDiff(ws);
          await setProposalStatus(artifactRoot, id, 'pr', {
            branch: ws.branch,
            workspace: ws.root,
            prCommand: command,
            diff,
          });
          say(`${id} → pr`);
          say(diff || '(diff shown at commit)');
          say(`to open the PR:\n    ${command}`);
          return { id, branch: ws.branch, files, prCommand: command };
        },
      });

      const brief = node({
        id: 'brief',
        type: 'tool',
        toolId: 'edit_brief',
        tools: [briefTool],
        reads: [recordNode.result],
      });
      const clone = node({
        id: 'clone',
        type: 'tool',
        toolId: 'clone_workspace',
        tools: [cloneTool],
        reads: [recordNode.result],
      });
      const edit = subgraph(child, {
        id: 'edit',
        reads: [brief.result],
        inputs: { [brief.result]: 'instruction' },
        outputs: { edit_report: 'edit_report' },
        maxIterations: MAX_EDIT_ITERATIONS,
      });
      const ship = node({
        id: 'ship',
        type: 'tool',
        toolId: 'ship_workspace',
        tools: [shipTool],
        reads: [recordNode.result, clone.result],
      });

      return {
        nodes: [brief, clone, edit, ship],
        edges: [
          { from: brief, to: clone },
          { from: clone, to: edit },
          { from: edit, to: ship },
        ],
        entry: brief,
        resultKey: ship.result,
      };
    })();

  const gateMerged = approval({
    id: 'gate_merged',
    prompt: 'Open the PR with the printed command. Approve once it has merged to record the corpus epoch; reject to finish later with `play merged`.',
    reviewKeys: [stage.resultKey],
    onReject: leave,
  });

  const stageExit = stage.nodes[stage.nodes.length - 1]!;
  return graph({
    name: `improve-${target.id}`,
    description: 'Measure, decide, and walk one proposal up the ladder behind human gates.',
    nodes: [tuneNode, recordNode, gateTrial, trialNode, gateApply, ...stage.nodes, gateMerged, mergedNode, leave],
    edges: [
      { from: tuneNode, to: recordNode },
      { from: recordNode, to: gateTrial, when: 'memory.record_result.count > 0' },
      { from: recordNode, to: leave, when: 'memory.record_result.count == 0' },
      { from: gateTrial, to: trialNode },
      { from: trialNode, to: gateApply },
      { from: gateApply, to: stage.entry },
      ...stage.edges,
      { from: stageExit, to: gateMerged },
      { from: gateMerged, to: mergedNode },
    ],
    startNode: tuneNode,
    endNodes: [mergedNode, leave],
  });
}

/**
 * Run one improve session over a target workflow.
 *
 * Recorded through the same machinery as any scenario run — artifacts,
 * events, pause/resume — under the `improve` scenario id, so the session is
 * itself traceable and forkable without ever counting as an observation of
 * the target.
 */
/**
 * The improve session as a Scenario value.
 *
 * Deliberately unregistered: `fork-check` and the pickers sweep the
 * registry, and an improve session is not a scenario anyone runs by name.
 * Exported so a recorded session can be REBUILT for forking — agent ids
 * are deterministic and the topology is identical, so a rebuild with the
 * same options (plus `workspaceAt` pinned to the session's clone) is the
 * faithful graph for `forkRecordedRun` to rewire against.
 */
export function improveScenario(
  target: Scenario,
  targetParams: unknown,
  stack: Stack,
  options: ImproveOptions,
): Scenario {
  return scenario({
    id: IMPROVE_SCENARIO_ID,
    title: `Improve ${target.id}`,
    covers: ['improve', 'ladder', 'approval'],
    requires: [],
    params: z.object({}),
    build: async () => ({
      graph: buildImproveGraph(target, targetParams, stack, options),
      input: {
        goal: `Improve '${target.id}': measure its knobs, and walk one proposal up the ladder as far as its reviewer approves.`,
      },
      runner: {},
    }),
  });
}

export async function improveWorkflow(
  target: Scenario,
  targetParams: unknown,
  stack: Stack,
  options: ImproveOptions,
): Promise<RunOutcome> {
  // The workspace path is minted here rather than inside the build, so the
  // session's recorded parameters name the clone its editor was jailed to —
  // which is what lets a later fork rebuild a faithful session from the
  // artifact alone.
  const workspaceAt = options.workspaceAt ?? join(tmpdir(), `cycgraph-ws-improve-${randomUUID()}`);
  const session = improveScenario(target, targetParams, stack, { ...options, workspaceAt });
  return executeScenario(session, {
    target: target.id,
    repoRoot: options.repoRoot,
    workspace: workspaceAt,
  }, stack, {
    hitl: options.hitl,
    ...(options.onEvent ? { onProgress: options.onEvent } : {}),
  });
}

/**
 * Recorded improve sessions, addressable as a tunable workflow.
 *
 * The tune pipeline is scenario-keyed: it loads a corpus by scenario id
 * and rebuilds the graph to enumerate knobs and rewire forks. Improve
 * sessions record under `improve` with self-describing parameters (their
 * target, repository, and workspace), and this value is the address that
 * turns that corpus into a target: `play tune improve` senses the
 * sessions, and a sweep over a child knob (`edit/edit` temperature)
 * measures through the mid-child fork dispatch.
 *
 * Deliberately NOT in any catalog — `fork-check` and the pickers sweep the
 * catalog, and running an improve session by picking it from a list is not
 * a thing. The CLI and the dashboard resolve the name `improve` to this
 * value explicitly, passing the catalog the sessions' targets resolve in.
 */
export const improveTuneTargetFor = (catalog: Pick<Catalog, 'find'>): Scenario => scenario({
  id: IMPROVE_SCENARIO_ID,
  title: 'Recorded improve sessions, addressable for tuning',
  covers: ['improve', 'self-hosting'],
  requires: ['model'],
  params: z.object({
    target: z.string().default('smoke-wasteful')
      .describe('Workflow the sessions improved'),
    repoRoot: z.string().default('')
      .describe('Repository the sessions cloned'),
    workspace: z.string().default('')
      .describe('Workspace clone an editor fork re-enters'),
  }),
  build: async (p, stack) => {
    const target = catalog.find(p.target);
    if (!target) {
      throw new Error(`improve sessions here targeted '${p.target}', which is not in this catalog`);
    }
    const reject = async () => ({ decision: 'rejected' as const });
    const graph = buildImproveGraph(target, target.params.parse({}), stack, {
      repoRoot: p.repoRoot,
      hitl: reject,
      ...(p.workspace ? { workspaceAt: p.workspace } : {}),
    });
    return {
      graph,
      input: {
        goal: `Improve '${p.target}': measure its knobs, and walk one proposal up the ladder as far as its reviewer approves.`,
      },
      runner: {},
      // A fork's tail can reach the ladder's gates; a rebuilt session has
      // no reviewer, and rejecting is the answer that changes nothing.
      hitl: reject,
    };
  },
});

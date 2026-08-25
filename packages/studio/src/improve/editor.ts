/**
 * The editor workflow: act, observe, correct — as graph topology
 *
 * The fix-loop editor. `locate` finds where the change lives; `edit` makes
 * it; `diagnose` runs the workspace's typecheck as a tool node; a verifier
 * gates on the result and routes failures back to `edit` with the errors in
 * its read slice, bounded by the run's iteration cap. This is a frontier
 * coding harness's act-observe-correct loop expressed natively: each
 * iteration's edit agent gets a fresh context holding exactly the target,
 * the current file state, and the errors — context economy enforced by
 * topology rather than achieved by summarization.
 *
 * The agents' hands are the `@cycgraph/tools` workspace set, registered
 * directly as custom tools: jailed to the clone, windowed reads,
 * read-before-edit and staleness enforced by a shared session. The verdict
 * on the whole session still comes from `verifyBuilt` outside the workflow —
 * the rebuilt workflow either carries exactly the proposed values or the
 * edit did not do what it claimed, whatever the transcript says.
 *
 * @module improve/editor
 */

import { join } from 'node:path';
import {
  agent,
  describeChange,
  graph,
  InMemoryAgentRegistry,
  node,
  run,
  verifier,
} from '@cycgraph/orchestrator';
import type { Change } from '@cycgraph/orchestrator';
import {
  createWorkspaceSession,
  diagnosticsTool,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import { threadClosure } from '../run/closure.js';
import type { ProposalRecord } from './proposals.js';
import type { Scenario } from '../scenarios/types.js';
import { providerFor, providersFor } from '../stack/index.js';
import type { Stack } from '../stack/index.js';

/** Fix-loop iterations before the editing session is declared stuck. */
export const MAX_EDIT_ITERATIONS = 12;

/**
 * Whether a freshly rebuilt scenario carries each change exactly.
 *
 * This is the verdict on the workflow's edit, and it is deliberately not the
 * workflow's to give: the built graph either holds the proposed value or the
 * edit did not do what it claimed, whatever the diff looks like.
 */
export async function verifyBuilt(
  scenario: Scenario,
  stack: Stack,
  changes: readonly Change[],
): Promise<string | undefined> {
  const params = scenario.params.parse({});
  const built = await scenario.build(params as never, stack);
  const agents = new InMemoryAgentRegistry();
  await threadClosure(built.graph, agents);

  for (const c of changes) {
    if (c.kind === 'config') {
      const current = built.graph.nodes.find(n => n.id === c.node_id);
      if (!current) return `the rebuilt graph has no node '${c.node_id}'`;
      for (const [key, expected] of Object.entries(c.patch)) {
        const actual = (current as unknown as Record<string, unknown>)[key];
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          return `${describeChange(c)}: the rebuilt node carries ${JSON.stringify(actual)} for '${key}', not the proposed value`;
        }
      }
      continue;
    }
    if (c.kind !== 'model' && c.kind !== 'prompt' && c.kind !== 'temperature') {
      return `${describeChange(c)} is not a durable change`;
    }
    const targetNode = built.graph.nodes.find(n => n.id === c.target);
    const entry = targetNode?.agent_id ? await agents.loadAgent(targetNode.agent_id) : null;
    if (!entry) return `the rebuilt graph has no agent behind '${c.target}'`;
    if (c.kind === 'model' && entry.model !== c.model) return `${describeChange(c)}: the rebuilt agent runs '${entry.model}'`;
    if (c.kind === 'prompt' && entry.system_prompt !== c.system_prompt) return `${describeChange(c)}: the rebuilt agent's prompt differs`;
    if (c.kind === 'temperature' && entry.temperature !== c.temperature) return `${describeChange(c)}: the rebuilt agent samples at ${entry.temperature}`;
  }
  return undefined;
}

/**
 * Build the fix-loop editor graph over a workspace root.
 *
 * The root need not exist yet: the tools are jailed to the path, and the
 * graph is only correct to run once something has cloned a repository
 * there. That late binding is what lets the improve ladder embed this graph
 * as a subgraph behind an approval gate — the tools are bound at build
 * time, the clone materializes when the gate approves.
 *
 * The instruction the session works from is read from the `instruction`
 * memory key, seeded directly by `editInWorkspace` or mapped in by a parent
 * graph's `inputs`.
 */
export function editorGraph(stack: Stack, workspaceRoot: string) {
  const session = createWorkspaceSession();
  const hands = {
    search: searchTool({ root: workspaceRoot }),
    read: readFileTool({ root: workspaceRoot, session }),
    edit: editFileTool({ root: workspaceRoot, session }),
    diagnose: diagnosticsTool({
      cwd: join(workspaceRoot, 'packages', 'playground'),
      command: 'npx',
      args: ['tsc', '--noEmit'],
    }),
    // `clean` here means git found NO modifications — the workspace is
    // untouched. The gate wants the opposite, so it negates this check.
    changed: diagnosticsTool({
      name: 'changed_check',
      cwd: workspaceRoot,
      command: 'git',
      args: ['diff', '--quiet'],
    }),
  };

  const model = stack.config.model;
  const provider = providerFor(model);

  const locator = agent({
    id: 'locator',
    name: 'Change locator',
    model,
    provider,
    temperature: 0.1,
    instructions: [
      'You locate where a configuration value is defined in a code repository, using search to find candidate files and read_file to confirm the exact spot.',
      'Many files mention a workflow; exactly one DEFINES it. Prefer the file that declares the workflow and its nodes — the one whose contents build the graph — over tests, harnesses, or documentation that merely reference it by name.',
      'Reply with two lines: the file path relative to the repository root, then the exact snippet where the value is written today.',
      "Quote the snippet from read_file output, exactly as the file holds it. Never quote search results: search prints 'NN:' line-number prefixes and strips indentation, and neither exists in the file.",
    ].join(' '),
    tools: [hands.search, hands.read],
  });

  const editorAgent = agent({
    id: 'editor',
    name: 'Workspace editor',
    model,
    provider,
    temperature: 0.1,
    instructions: [
      'You permanently apply one configuration change to a code repository. The target file and snippet have been located for you; read_file the file, then edit_file the smallest change that moves the configured value and nothing else.',
      'edit_file requires the file to have been read first, and refuses an ambiguous match — react by reading and bringing more surrounding context.',
      "The find text must be the file's exact bytes as read_file shows them: never include 'NN:' line-number prefixes from search results, and never change indentation.",
      'If diagnostics errors are present in your input, your previous edit broke the build: read the errors, read the file, and fix your edit.',
      'If the change check reports the workspace is untouched, you have not actually edited anything yet — call edit_file now; a reply without an edit_file call achieves nothing.',
      'When the edit is made, reply with one line: EDITED <path>.',
    ].join(' '),
    tools: [hands.read, hands.edit],
  });

  const locate = node({
    id: 'locate',
    agent: locator,
    reads: ['instruction'],
    writes: 'target',
  });
  const edit = node({
    id: 'edit',
    agent: editorAgent,
    reads: ['instruction', 'target', 'diagnose_result', 'changed_result'],
    writes: 'edit_report',
  });
  const diagnose = node({
    id: 'diagnose',
    type: 'tool',
    toolId: 'diagnostics',
    tools: [hands.diagnose],
    reads: [],
  });
  const changed = node({
    id: 'changed',
    type: 'tool',
    toolId: 'changed_check',
    tools: [hands.changed],
    reads: [],
  });
  // The gate verifies the session's actual objective, not just its safety
  // half: the build must be clean AND the workspace must differ from HEAD.
  // An editor that replies without editing produces a trivially clean
  // typecheck, and only the second clause routes that back for another
  // attempt instead of letting it sail through.
  const gate = verifier.expression(
    `memory.${diagnose.result}.clean and not memory.${changed.result}.clean`,
    {
      id: 'gate',
      reads: [diagnose.result, changed.result],
      description: 'The workspace typechecks and actually carries an edit',
    },
  );
  const done = node({ id: 'done', type: 'router' });

  return graph({
    name: 'workspace-editor',
    description: 'Locate, edit, diagnose, and loop until the workspace carries a clean edit.',
    nodes: [locate, edit, diagnose, changed, gate, done],
    edges: [
      { from: locate, to: edit },
      { from: edit, to: diagnose },
      { from: diagnose, to: changed },
      { from: changed, to: gate },
      { from: gate, to: done, when: 'memory.gate_verification_passed' },
      { from: gate, to: edit, when: 'not memory.gate_verification_passed' },
    ],
    startNode: locate,
    endNodes: [done],
  });
}

/** The editing brief one proposal implies, as the locate/edit agents read it. */
export function editInstructionFor(record: ProposalRecord, sourcePath?: string): string {
  const changes = record.change;
  return [
    `Workflow '${record.workflow}': change ${changes.map(describeChange).join('; ')}.`,
    `The knob is '${record.knob}' on node '${record.nodeId}', moving from ${JSON.stringify(record.from)} to ${JSON.stringify(record.to)}.`,
    `Full change payload: ${JSON.stringify(changes)}.`,
    sourcePath
      ? `This workflow is defined in '${sourcePath}'. Edit that file — do not search for another.`
      : `A good starting search is the workflow name '${record.workflow}' or the current value.`,
  ].join('\n');
}

/**
 * Run the fix-loop editor over a workspace clone.
 *
 * Returns the workflow's own account of the session — the edit report, plus
 * whether the diagnostics gate was still failing at the iteration cap —
 * which is informational: the caller's verify decides what actually
 * happened.
 */
export async function editInWorkspace(
  stack: Stack,
  workspaceRoot: string,
  record: ProposalRecord,
  sourcePath?: string,
): Promise<string> {
  const g = editorGraph(stack, workspaceRoot);
  const providers = providersFor(stack.config.model, stack.config.endpoints.ollama);
  const memory = await run(g, {
    goal: 'Apply the change to the repository, keep it building, and report the edited file.',
    maxIterations: MAX_EDIT_ITERATIONS,
    memory: { instruction: editInstructionFor(record, sourcePath) },
  }, {
    ...(providers ? { providers } : {}),
  });

  // A session can end without writing its report — the iteration cap, or a
  // final turn that called tools and said nothing. `JSON.stringify` returns
  // undefined for undefined, so this has to be said rather than formatted.
  const raw = memory['edit_report'];
  const report = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw);
  const headline = report.split('\n')[0] || 'the editing session ended without reporting an edit';
  const clean = (memory['diagnose_result'] as { clean?: boolean } | undefined)?.clean;
  return `${headline}${clean === false ? ' (diagnostics still failing at the iteration cap)' : ''}`;
}

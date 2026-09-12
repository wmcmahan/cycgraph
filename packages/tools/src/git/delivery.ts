/**
 * The delivery tail every repository-writing workflow shares.
 *
 * `deliveryNodes` builds the clone, commit, and publish nodes of the
 * maintenance pattern (sense → act → judge → checks → gate → deliver),
 * so workflows differ in what they sense and fix while delivering
 * identically: commit to a branch under a configured identity, push,
 * and open a pull request whose body follows the repository's template.
 * The caller wires the nodes into its graph and owns every edge.
 *
 * Like the rest of this module, these are caller-side procedures: the
 * tools inside the nodes run deterministically on the workflow's
 * behalf and are never handed to a model.
 *
 * @module git/delivery
 */

import { node, tool, type NodeValue } from '@cycgraph/orchestrator';
import { z } from 'zod';
import { branchDiff, cloneToBranch, commit as commitBranch, pendingDiff, publishBranch, publishScript } from './branch.js';
import { type PublishConfig } from './config.js';
import { prBodyFor, type PrEvidence } from './template.js';

/** How a delivery is configured, per build. */
export interface DeliveryOptions {
  /** Repository the workspace is cloned from and the branch returns to. */
  repoRoot: string;
  /** Where the clone materialises. Chosen before it exists so tools can be jailed to it. */
  workspaceAt: string;
  /** Branch the change is delivered on. */
  branch: string;
  /** Commit and PR title, used when the change describes no subject of its own. */
  title: string;
  /**
   * Memory key whose value describes the delivered change; its `detail`
   * property (or the value itself, when a string) becomes the commit
   * message body and the default PR evidence. A `subject` property, when
   * present, becomes that commit's subject line in place of `title`, and
   * a delivery of exactly one subject-carrying commit titles its PR with
   * it too — so git history names the actual change, not the workflow.
   */
  detailFrom: string;
  /**
   * Turn the accumulated details — one per commit the delivery has made
   * — into PR evidence. Defaults to a summary joining them.
   */
  evidence?: (details: string[]) => PrEvidence;
  /** Commit the change. Off leaves the workspace for inspection. Default true. */
  commit?: boolean;
  /** Push and open the PR. Off leaves the prepared script in the commit result. Default true. */
  publish?: boolean;
  /** Credentials and identity, from `publishConfigFromEnv` or the caller. */
  config?: PublishConfig;
}

function detailOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'detail' in value) {
    return String((value as { detail: unknown }).detail ?? '');
  }
  return '';
}

const SUBJECT_MAX = 72;

/** The change's own commit subject, when the detail value carries one. */
function subjectOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || !('subject' in value)) return undefined;
  const raw = (value as { subject: unknown }).subject;
  if (typeof raw !== 'string') return undefined;
  const line = raw.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : line;
}

/** A wired delivery node, with the memory key its result lands under. */
export type DeliveryNode = NodeValue & { readonly result: string };

/**
 * Build the delivery nodes: `clone`, `commit`, `publish`.
 *
 * Clone belongs at the start of the graph, commit and publish after its
 * gate. Commit is batch-aware: a graph that cycles back through it
 * commits once per verified fix on the same branch, accumulating
 * `count` and `details` by reading its own previous result, and its
 * `diff` always spans the whole branch. Publish refuses nothing loudly:
 * with publishing off or nothing committed it reports why and the run
 * stays clean; a push failure throws, and a PR-step failure leaves the
 * pushed branch with a remediation URL in the result (see
 * `publishBranch`).
 */
export function deliveryNodes(
  options: DeliveryOptions,
): { clone: DeliveryNode; commit: DeliveryNode; publish: DeliveryNode } {
  const {
    repoRoot, workspaceAt, branch, title, detailFrom,
    evidence = (details: string[]) => ({ summary: details.join('\n') }),
  } = options;
  const ws = { root: workspaceAt, branch };

  const cloneTool = tool({
    name: 'clone_repo',
    description: 'Clone the repository into a disposable workspace.',
    parameters: z.object({}),
    execute: async () => {
      const made = await cloneToBranch(repoRoot, branch, { at: workspaceAt });
      return { workspace: made.root, branch: made.branch };
    },
  });

  const commitTool = tool({
    name: 'commit_change',
    description: 'Commit the verified change to the workspace branch.',
    parameters: z.object({
      [detailFrom]: z.unknown().optional(),
      commit_result: z.unknown().optional(),
    }),
    execute: async (args) => {
      const detail = detailOf(args[detailFrom]);
      const subject = subjectOf(args[detailFrom]) ?? title;
      const prior = args['commit_result'] as { count?: number; details?: string[]; subjects?: string[] } | undefined;
      const priorCount = prior?.count ?? 0;
      const priorDetails = prior?.details ?? [];
      const priorSubjects = prior?.subjects ?? [];
      if (options.commit === false) {
        return {
          committed: false,
          count: priorCount,
          details: priorDetails,
          subjects: priorSubjects,
          workspace: ws.root,
          diff: await pendingDiff(ws.root),
        };
      }

      await commitBranch(ws.root, `${subject}\n\n${detail}`.trim(), options.config?.identity);
      const count = priorCount + 1;
      const details = [...priorDetails, detail];
      const subjects = [...priorSubjects, subject];
      const body = await prBodyFor(repoRoot, evidence(details));
      return {
        committed: true,
        count,
        details,
        subjects,
        workspace: ws.root,
        branch: ws.branch,
        diff: await branchDiff(ws.root, count),
        prCommand: publishScript(ws, repoRoot, count === 1 ? subject : title, body),
      };
    },
  });

  const publishTool = tool({
    name: 'publish_pr',
    description: 'Push the committed branch to origin and open a pull request.',
    parameters: z.object({
      commit_result: z.unknown().optional(),
      [detailFrom]: z.unknown().optional(),
    }),
    execute: async (args) => {
      const prior = args['commit_result'] as
        { committed?: boolean; details?: string[]; subjects?: string[] } | undefined;
      const committed = prior?.committed === true;
      if (options.publish === false || !committed) {
        return {
          published: false,
          detail: committed ? 'publishing is off; the commit result carries the script' : 'nothing was committed',
        };
      }
      const details = prior?.details ?? [detailOf(args[detailFrom])];
      const subjects = prior?.subjects ?? [];
      const prTitle = subjects.length === 1 ? subjects[0]! : title;
      const body = await prBodyFor(repoRoot, evidence(details));
      const outcome = await publishBranch(ws, repoRoot, prTitle, body, options.config);
      return { published: outcome.prUrl !== undefined, branch: ws.branch, ...outcome };
    },
  });

  const clone = node({ id: 'clone', type: 'tool', toolId: 'clone_repo', tools: [cloneTool] });
  // Commit reads its own result key so a batching graph accumulates
  // count and details across cycles; on the first pass the key is absent.
  const commit = node({
    id: 'commit',
    type: 'tool',
    toolId: 'commit_change',
    tools: [commitTool],
    reads: [detailFrom, 'commit_result'],
  });
  const publish = node({
    id: 'publish',
    type: 'tool',
    toolId: 'publish_pr',
    tools: [publishTool],
    reads: [commit.result, detailFrom],
  });

  return { clone, commit, publish };
}

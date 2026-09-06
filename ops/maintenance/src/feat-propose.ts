/**
 * feat-propose — the feature-ticket ladder's first rung.
 *
 * An agent studies the codebase read-only and writes one well-formed
 * feature proposal: motivation, design sketch, evidence naming real
 * files, and mechanically checkable acceptance criteria. The gate is
 * structural (`proposal.ts`) — a proposal a human cannot review is
 * refused, and evidence must name at least one path the repository
 * actually has. What passes becomes a ticket, marker-keyed and deduped;
 * approval (`maintenance-approved`), implementation, and the PR ride
 * the same ladder as every other approved issue, and the merge is the
 * feature's only honest fitness signal.
 *
 * Nothing is edited: the proposer's hands are search and read only.
 *
 * @module maintenance/feat-propose
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { agent, graph, node, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { cloneToBranch, createIssue, findingMarker, issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { createWorkspaceSession, readFileTool, searchTool } from '@cycgraph/tools/workspace';
import { parseProposal, pathTokens, proposalKey } from './proposal.js';
import { resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the feature is proposed for. Empty means the repository this runs inside'),
  focus: z.string().default('')
    .describe('Steer the proposal toward an area or goal, e.g. "authoring ergonomics". Empty lets the agent choose'),
  attempts: z.number().int().min(1).max(6).default(2)
    .describe('Proposal attempts before the run gives up'),
  file: z.boolean().default(true)
    .describe('File the proposal as an issue. Off reports the proposal and verdict only'),
  prompt: z.string().default('')
    .describe('Override the proposer agent\'s instructions'),
});

type Params = z.infer<typeof params>;

/** The feat-propose workflow. */
export function featPropose(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'feat-propose',
    title: 'Propose one well-formed feature as a ticket',
    covers: ['maintenance', 'feature', 'proposal'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-feat-${randomUUID()}`);
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
      };

      const cloneTool = tool({
        name: 'clone_repo',
        description: 'Clone the repository into a disposable read-only workspace.',
        parameters: z.object({}),
        execute: async () => {
          const ws = await cloneToBranch(repoRoot, `feat/scan-${randomUUID().slice(0, 8)}`, { at: workspaceAt });
          return { workspace: ws.root };
        },
      });

      const shapeTool = tool({
        name: 'check_shape',
        description: 'Validate the proposal\'s structure and that its evidence names real files.',
        parameters: z.object({ proposal: z.unknown().optional() }),
        execute: async ({ proposal }) => {
          const parsed = parseProposal(String(proposal ?? ''));
          const evidencePaths = pathTokens(parsed.evidence)
            .filter((token) => existsSync(join(workspaceAt, token)));
          const evidenceOk = evidencePaths.length > 0;
          const valid = parsed.missing.length === 0 && evidenceOk;
          return {
            valid,
            title: parsed.title,
            acceptance_count: parsed.acceptance.length,
            evidence_paths: evidencePaths,
            missing: parsed.missing,
            // A refusal in CI is only diagnosable from the run log, so an
            // invalid proposal carries its own head.
            ...(valid ? {} : { proposal_head: String(proposal ?? '').slice(0, 400) }),
            detail: valid
              ? `well-formed: '${parsed.title}' with ${parsed.acceptance.length} acceptance criteria`
              : parsed.missing.length > 0
                ? `missing sections: ${parsed.missing.join(', ')}`
                : 'evidence names no file the repository actually has — cite real paths',
          };
        },
      });

      const ticketTool = tool({
        name: 'file_ticket',
        description: 'File the well-formed proposal as a marker-keyed, deduped issue.',
        parameters: z.object({
          shape_result: z.unknown().optional(),
          proposal: z.unknown().optional(),
        }),
        timeoutMs: 120_000,
        execute: async ({ shape_result, proposal }) => {
          const shape = shape_result as { title?: string } | undefined;
          const key = proposalKey(shape?.title ?? '');
          if (!p.file) return { filed: false, key, detail: 'dry run' };

          const issues = await listOpenIssues(repoRoot, token !== undefined ? { token } : {});
          if (issues === undefined) {
            return { filed: false, key, detail: 'cannot read the issue ledger — refusing to file blind' };
          }
          if (issueMarkers(issues).has(key)) {
            return { filed: false, key, detail: 'an open ticket already carries this proposal' };
          }

          const outcome = await createIssue(repoRoot, {
            title: `[feature] ${shape?.title ?? 'proposal'}`,
            body: [
              String(proposal ?? ''),
              '',
              'Proposed by the feat-propose workflow from a read-only study of the codebase.',
              'Approve with the `maintenance-approved` label; implementation and the PR follow the maintenance ladder, and the merge is the accept signal.',
              '',
              findingMarker(key),
            ].join('\n'),
          }, token !== undefined ? { token } : {});
          return 'url' in outcome
            ? { filed: true, key, url: outcome.url, detail: `filed ${outcome.url}` }
            : { filed: false, key, detail: `could not file: ${outcome.error}` };
        },
      });

      const proposer = agent({
        id: 'feature-proposer',
        name: 'Feature proposer',
        model: env.model,
        provider: env.provider,
        temperature: 0.4,
        instructions: p.prompt !== '' ? p.prompt : [
          'You study a codebase read-only and propose exactly ONE feature worth building.',
          p.focus !== '' ? `Focus area: ${p.focus}.` : 'Choose the highest-leverage gap you can defend with evidence.',
          'Use search and read_file to ground every claim; never invent files or APIs.',
          'Reply in exactly this format, with these headers on their own lines:',
          'TITLE: <one line naming the feature>',
          'MOTIVATION:', '<why this matters, grounded in what the code does today>',
          'DESIGN:', '<a sketch of the change: which modules, which surfaces, what stays untouched>',
          'EVIDENCE:', '<real repository paths you read, with what each shows>',
          'ACCEPTANCE:', '- <a mechanically checkable criterion: a command that must pass, or a concrete observable behavior>',
          'Every acceptance bullet must be checkable by a machine or a reviewer without judgement calls.',
          'Command criteria should be workspace-scoped (npm run <script> --workspace=<pkg>, or npx vitest run <path>) so they run fast and only exercise what the feature touches.',
          'If a previous attempt is reported as malformed, fix exactly what the report names.',
        ].join('\n'),
        tools: [hands.search, hands.read],
      });

      const clone = node({ id: 'clone', type: 'tool', toolId: 'clone_repo', tools: [cloneTool] });
      const propose = node({
        id: 'propose',
        agent: proposer,
        reads: ['shape_result'],
        writes: 'proposal',
      });
      const shape = node({
        id: 'shape',
        type: 'tool',
        toolId: 'check_shape',
        tools: [shapeTool],
        reads: ['proposal'],
      });
      const gate = verifier.expression(
        `memory.${shape.result}.valid`,
        {
          id: 'gate',
          reads: [shape.result],
          description: 'The proposal is reviewable: all sections present, evidence names real files',
        },
      );
      const ticket = node({
        id: 'ticket',
        type: 'tool',
        toolId: 'file_ticket',
        tools: [ticketTool],
        reads: [shape.result, 'proposal'],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'feat-propose',
          description: 'Study the codebase read-only; a reviewable feature proposal becomes a ticket.',
          nodes: [clone, propose, shape, gate, ticket, report],
          edges: [
            { from: clone, to: propose },
            { from: propose, to: shape },
            { from: shape, to: gate },
            { from: gate, to: ticket, when: 'memory.gate_verification_passed' },
            { from: gate, to: propose, when: 'not memory.gate_verification_passed' },
            { from: ticket, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        // clone + attempts × (propose, shape, gate) + ticket + report:
        // exactly enough for the last allowed attempt to finish filing.
        input: { goal: 'Propose one well-formed feature.', maxIterations: 3 + p.attempts * 3 },
        runner: {},
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'shape_result' },
    ],
  };
}

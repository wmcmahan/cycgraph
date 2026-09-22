/**
 * docs-maintenance — a workflow that keeps this repository's docs honest.
 *
 * A workflow of ours, not a product feature: the detectors encode what
 * staleness means here. It speaks engine vocabulary only, so any harness
 * can run it; the playground registry wraps it into the studio's catalog.
 *
 * The first of the maintenance workflows, and the pattern the others copy.
 * It takes up to `batch` mechanically-detected findings per run, fixes each
 * in a disposable clone, and proves every fix by re-scanning: the targeted
 * finding is gone, nothing new appeared, and the repository's own checks
 * still pass. Each verified fix is its own commit on one branch; the run
 * ends with one pull request, and the human gate is the merge.
 *
 * `docsMaintenance(options)` is one parameterized workflow; the two
 * registered variants below are it with a scope. This file is the composer:
 * `build` resolves the shared context, then assembles the tools, the
 * agents, the delivery nodes, the graph-owned nodes, and the graph, each
 * from its own file.
 *
 * @module maintenance/docs
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { deliveryNodes } from '@cycgraph/tools/git';
import { templateEvidence } from '../shared/pr-template.js';
import { buildDocsContext, params } from './context.js';
import type { DocsMaintenanceOptions, Params } from './context.js';
import { docsTools } from './tools/index.js';
import { fixerAgent, distillerAgent } from './agents/index.js';
import { docsNodes } from './nodes/index.js';
import { docsGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

export type { DocsMaintenanceOptions } from './context.js';

/**
 * The docs-maintenance workflow.
 *
 * Exposed as a factory rather than a value because the workspace tools are
 * jailed to a clone path chosen per build. `repoDocsMaintenance` and
 * `websiteDocsMaintenance` are the two registered variants; each is this
 * workflow with a scope.
 */
export function docsMaintenance(options: DocsMaintenanceOptions = {}): MaintenanceWorkflow<typeof params> {
  const id = options.id ?? 'docs-maintenance';
  return {
    id,
    title: options.title ?? 'Fix one stale thing the documentation claims',
    covers: ['maintenance', 'docs', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const c = await buildDocsContext(options, p, env);
      const tools = docsTools(c);
      const agents = { fixer: fixerAgent(c, tools), distiller: distillerAgent(c) };

      // The shared delivery tail: clone at the start, commit and publish
      // after the gate. The judge's verdict detail becomes the commit
      // message body and the PR evidence.
      const delivery = deliveryNodes({
        repoRoot: c.repoRoot,
        workspaceAt: c.workspaceAt,
        branch: c.branchName,
        title: p.batch > 1 ? 'docs: correct stale references' : 'docs: correct a stale reference',
        detailFrom: 'judge_result',
        evidence: (details: string[], ev: { diff: string }) => ({
          summary: details.length === 1
            ? `Found and verified by the ${c.id} workflow. ${details[0]}`
            : `Found and verified by the ${c.id} workflow: ${details.length} documentation fixes, one commit each.`,
          ...(details.length > 0 ? { changes: details } : {}),
          provenance: `${c.id}: each finding was detected mechanically, fixed by an agent in a jailed clone, and verified by re-scan and repository checks before its commit.`,
          ...templateEvidence(ev.diff, { checks: p.checks, details }),
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      const nodes = docsNodes(c, tools, agents);
      return docsGraph(c, nodes, delivery);
    },

    // The verdict is mechanical, so the workflow can be measured and tuned
    // like any other. The gate's own boolean is the objective signal: it
    // passes only when the claim was corrected rather than deleted and the
    // checks held.
    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'judge_result' },
      { type: 'memory_matches', key: 'gate_verification_passed', mode: 'exact', expected: true, pattern: '' },
    ],
  };
}

/** The repository's own docs: READMEs, guides, everything outside the website. */
export function repoDocsMaintenance(): MaintenanceWorkflow<typeof params> {
  return docsMaintenance({
    id: 'fix-repo-docs',
    title: 'Fix stale claims in the repository docs',
    exclude: ['apps/docs'],
  });
}

/** The documentation website under apps/docs. */
export function websiteDocsMaintenance(): MaintenanceWorkflow<typeof params> {
  return docsMaintenance({
    id: 'fix-website-docs',
    title: 'Fix stale claims in the website docs',
    roots: ['apps/docs'],
  });
}

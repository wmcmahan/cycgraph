/**
 * The lesson distiller: the cross-run learning tail.
 *
 * The `reflect` node's LLM extractor. It distills a run's sift accounting
 * into transferable lessons for future auditors. See the docs workflow for
 * the pattern.
 *
 * @module maintenance/repo-audit/agents/distiller
 */

import { agent } from '@cycgraph/orchestrator';
import type { RepoAuditContext } from '../context.js';

/** Build the audit lesson-distiller agent (no tools; used by `reflect`). */
export function distillerAgent(c: RepoAuditContext) {
  const { env } = c;
  return agent({
    id: 'repo-audit-lesson-distiller',
    name: 'Audit lesson distiller',
    model: env.model,
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 1,
    instructions: [
      'You distill a repository-audit run\'s sift accounting into transferable lessons for future auditors.',
      'The sift result shows what survived and why findings were dropped: malformed blocks, evidence naming no real path, duplicates, already-filed, plus which reports came back clean.',
      'A lesson is one present-tense sentence that would change how the NEXT audit works: a reporting-format failure and its remedy, a charter that repeatedly turns up nothing, an evidence pattern that survives the sift.',
      'Never include run-specific details (finding titles, dates). Return no facts when nothing transferable happened.',
    ].join(' '),
  });
}

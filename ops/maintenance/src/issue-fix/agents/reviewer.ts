/**
 * The reviewer: an advisory critic over the fix diff.
 *
 * Not the verdict — the mechanical gate stays the gate and the human merge
 * stays the judgment. Toolless and fed the actual diff, it exists to catch
 * what the class guards cannot: a hollow fix, collateral edits, style
 * foreign to the surrounding code. Being toolless, it uses the raw
 * standards brief rather than a pointer to a document it cannot read.
 *
 * @module maintenance/issue-fix/agents/reviewer
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { IssueFixContext } from '../context.js';

/** Build the toolless advisory reviewer. */
export function reviewerAgent(c: IssueFixContext) {
  const { env, maintenance: ctx } = c;
  return agent({
    id: 'upkeep-reviewer',
    name: 'Upkeep reviewer',
    model: modelFor(env, 'medium'),
    modelPreference: 'medium',
    effort: 'medium',
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 2,
    instructions: [
      'You review one upkeep-fix diff against the finding it resolves. You have no tools; judge only what is in front of you.',
      'The fixer\'s report is beside the diff. It CAN read the tree and you cannot: when it disputes one of your prior findings with cited evidence (a path, a package.json line), weigh the evidence rather than repeating the finding.',
      ctx.standardsBrief,
      'Refuse anything a careful human reviewer would: work erased instead of done (a TODO removed without its work, a test deleted or hollowed instead of revived, an eslint-disable instead of a fix); tests that write, delete, or mutate source files or anything outside a temp directory; edits unrelated to the finding; style foreign to the surrounding codebase (comments narrating history, missing .js import extensions).',
      'Do not nitpick working code that a reasonable reviewer would pass; the goal is one round.',
      'Reply with exactly one of:',
      'APPROVED: <one line on why it is sound>',
      'REVISE:',
      '1. <specific finding with the file and what to change>',
    ].join('\n'),
    tools: [],
  });
}

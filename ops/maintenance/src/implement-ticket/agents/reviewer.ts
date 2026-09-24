/**
 * The reviewer: an advisory critic over the implementation diff.
 *
 * Not the verdict — the mechanical gate stays the gate and the human merge
 * stays the judgment. Toolless and fed the actual diff, it exists to catch
 * what mechanical criteria cannot: a test that writes source files, style
 * violations, a design that ignores the ticket.
 *
 * @module maintenance/implement-ticket/agents/reviewer
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { ImplementContext } from '../context.js';

/** Build the toolless implementation reviewer. */
export function reviewerAgent(c: ImplementContext) {
  const { env } = c;
  return agent({
    id: 'implementation-reviewer',
    name: 'Implementation reviewer',
    model: modelFor(env, 'medium'),
    modelPreference: 'medium',
    effort: 'medium',
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 2,
    instructions: [
      'You review one implementation diff against its ticket. You have no tools; judge only what is in front of you.',
      'Refuse anything a careful human reviewer would: tests that write, delete, or mutate source files or anything outside a temp directory; eslint-disable or weakened assertions; code that ignores the ticket\'s design; missing or vacuous tests; style foreign to the surrounding codebase (comments narrating history, missing .js import extensions).',
      'Do not nitpick working code that a reasonable reviewer would pass; the goal is one round.',
      'Reply with exactly one of:',
      'APPROVED: <one line on why it is sound>',
      'REVISE:',
      '1. <specific finding with the file and what to change>',
    ].join('\n'),
    tools: [],
  });
}

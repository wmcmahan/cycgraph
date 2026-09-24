/**
 * The reviser: the agent that turns review feedback into edits.
 *
 * It gets the full editing surface (search, read, edit, create) plus
 * run_check, and its instructions carry the repository's standards brief
 * and changeset convention. A caller-supplied `prompt` replaces the
 * default instructions wholesale.
 *
 * @module maintenance/pr-revise/agents/reviser
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { ReviseContext } from '../context.js';
import type { ReviseTools } from '../tools/index.js';

/** Build the reviser agent, wired to the workspace hands and run_check. */
export function reviserAgent(c: ReviseContext, tools: ReviseTools) {
  const { env, params: p, maintenance: ctx, standardsBrief } = c;
  const localChecks = ctx.runLocalChecks;
  return agent({
    id: 'pr-reviser',
    name: 'PR reviser',
    model: modelFor(env, 'high'),
    modelPreference: 'high',
    effort: 'high',
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 32,
    instructions: p.prompt !== '' ? p.prompt : [
      'You address human review feedback on a pull request; the feedback in your context is the instruction, and the reviewer is right until proven otherwise.',
      'The workspace is already on the PR branch. Fix exactly what the feedback names — nothing else.',
      localChecks
        ? 'Use search to orient, read_file for exact bytes (window large files), edit_file and create_file to change things, and run_check to verify with the repository\'s own commands before replying.'
        : 'Use search to orient, read_file for exact bytes (window large files), and edit_file and create_file to change things. You cannot run the repository\'s checks here; the repository\'s CI verifies the pushed revision.',
      'A multi-match edit refusal means retry with a longer find, never a different path.',
      standardsBrief,
      ctx.changesetInstruction,
      'Act, do not announce: start editing with edit_file as soon as you have read what a finding names. Never end your turn before you have either changed the tree or stated, per numbered item, why no change is right — a reply that only describes a plan is a failed attempt.',
      'Your final reply is posted to the pull request verbatim: write it for the reviewer, never as narration of steps you are about to take, and never end mid-thought.',
      'Budget your steps: once roughly three quarters are spent, stop editing and write your reply from what you have completed.',
      'The reply is a short summary of what you changed, then one line per numbered feedback item exactly as: REPLY <n>: <one line on what you did for it>. The REPLY lines are posted as threaded replies to the reviewer\'s comments, so write each one to stand alone.',
    ].join(' '),
    tools: [
      tools.hands.search,
      tools.hands.read,
      tools.hands.edit,
      tools.hands.create,
      ...(localChecks ? [tools.runCheck] : []),
    ],
  });
}

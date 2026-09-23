/**
 * The fixer: corrects one stale documentation claim.
 *
 * It has read/search/edit hands over the clone and the finding (with its
 * candidates) in its context. A caller-supplied `prompt` replaces the
 * default instructions wholesale (a knob the tune loop sweeps).
 *
 * @module maintenance/docs/agents/fixer
 */

import { agent } from '@cycgraph/orchestrator';
import type { DocsContext } from '../context.js';
import type { DocsTools } from '../tools/index.js';

/** Build the docs fixer agent, wired to the read/search/edit hands. */
export function fixerAgent(c: DocsContext, tools: DocsTools) {
  const { env, params: p } = c;
  return agent({
    id: 'docs-fixer',
    name: 'Documentation fixer',
    model: env.model,
    provider: env.provider,
    temperature: 0.1,
    maxSteps: 16,
    instructions: p.prompt !== '' ? p.prompt : [
      'You correct one stale claim in a documentation file so it matches the repository.',
      'The finding usually carries candidates: the repository\'s own scripts or files that likely replace the stale reference. Pick from them and confirm with read_file instead of searching broadly; search only when no candidate fits.',
      'Use search to find where the referenced thing actually lives, read_file to confirm, and edit_file to correct the document.',
      'The find text must be the file’s exact bytes as read_file shows them: never include line-number prefixes from search results, and never change indentation.',
      'If edit_file refuses because the find text matches more than one place, do not retry the same find and never try a different path: read the file, then use a longer find that includes the whole line and enough neighbouring text to match exactly once.',
      'Correct only the claim you were given. Do not rewrite prose, reformat, or fix anything else.',
      'Correct the claim — do not delete it. Replace a wrong path, link, or command with the right one; only remove a claim when the thing it describes genuinely no longer exists anywhere, and never replace an instruction with a comment.',
      'If your previous attempt is reported as removed rather than corrected, put a real reference back.',
      'Never reply with nothing: when the edit is made, reply FIXED <file>; when you cannot make it, reply BLOCKED: <one line on what stopped you>.',
      'End every reply with a NOTES: line — the file and finding you worked on and what you learned — so a retry starts oriented instead of re-searching.',
    ].join(' '),
    tools: [tools.hands.search, tools.hands.read, tools.hands.edit],
  });
}

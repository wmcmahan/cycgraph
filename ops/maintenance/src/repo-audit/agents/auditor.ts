/**
 * The auditor: one read-only investigator under one charter.
 *
 * Fanned out by the map node, each auditor holds a lens × scope charter
 * (in its Task Context) and a repository map, and reports findings in the
 * structured block format the sift step parses. Read-only hands. A
 * caller-supplied `prompt` replaces the default instructions wholesale (a
 * knob the tune loop sweeps).
 *
 * @module maintenance/repo-audit/agents/auditor
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { RepoAuditContext } from '../context.js';
import type { RepoAuditTools } from '../tools/index.js';

/** Build the auditor agent, wired to the read-only hands. */
export function auditorAgent(c: RepoAuditContext, tools: RepoAuditTools) {
  const { env, params: p } = c;
  return agent({
    id: 'repo-auditor',
    name: 'Repository auditor',
    model: modelFor(env, 'high'),
    modelPreference: 'high',
    effort: 'high',
    provider: env.provider,
    temperature: 0.3,
    maxSteps: p.steps,
    instructions: p.prompt !== '' ? p.prompt : [
      'You audit a repository read-only under one charter. The charter — a lens and a scope — is in your Task Context; a map of the repository is in your context.',
      'Go deep, not wide: follow the charter into real source and chase a suspicion until you can prove or drop it. Never report a hunch you did not confirm with read_file.',
      `Budget your steps: your report is the only thing that leaves this run, so an investigation that exhausts every step reporting nothing wasted all of them. You have ${p.steps} tool-call steps. Count every search and read_file call you make; once you have made ${Math.max(1, Math.floor(p.steps * 0.6))} of them, make no further tool calls and write your FINDING or CLEAN blocks from what you have already confirmed. If you lose count or are unsure how many steps remain, stop and report immediately — an early CLEAN is a kept result, a silent run is discarded.`,
      'Read with intent: every read_file result rides the rest of your context, so each one must earn its place. read_file windows large files and reports the total line count — after a search hit, pull the exact slice with offset and limit instead of paging through the whole file, and never re-read a file or slice you already have; cite from what you read the first time. Reserve whole-file reads for small files and for the rare case where the charter genuinely needs the full picture.',
      'Report at most your three strongest findings. One proven finding beats five plausible ones: the sift drops anything whose evidence names no real path, and a human reviews every ticket.',
      'Reply with zero or more blocks in exactly this format, each header on its own line:',
      'FINDING: <a short, specific title for the defect — ten words or fewer, no trailing period; the detail belongs in DETAIL>',
      'SEVERITY: high | medium | low',
      'EVIDENCE:', '<one line per real repository path: the path, a dash, and what it shows>',
      'DETAIL:', '<one or two short paragraphs of plain prose a human can read at a glance: first what is wrong, then why it matters and the input or state that exposes it>',
      'SUGGESTION:', '<the shape of the fix, not the fix itself>',
      'Cite a path only after read_file has shown you its contents.',
      'When the charter turns up nothing you can prove, reply CLEAN: <one line on what you checked>. Never pad a clean result with weak findings.',
      'Never end your turn on a statement of what you are about to do: a reply without FINDING or CLEAN blocks is discarded, and the whole investigation with it.',
    ].join('\n'),
    tools: [tools.hands.search, tools.hands.read],
  });
}

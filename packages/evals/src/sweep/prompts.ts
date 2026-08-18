/**
 * Prompt sweeps: the generated tier
 *
 * The one knob with no finite candidate set. A budget is swept by halving, a
 * model by walking a list, but a prompt has to be written, and writing one
 * takes a model. This module holds everything around that call except the
 * call itself: what the generator is told, what its output must survive to
 * become a candidate, and the sweep the survivors form.
 *
 * The split is the safety property. The generator proposes and nothing more:
 * its output becomes `change.prompt` variants in an ordinary reliability
 * sweep, with the current prompt as the control arm, judged by the same exact
 * rate test as a temperature sweep. The generator never grades its own work,
 * and a generated prompt that does not beat the current one distinguishably
 * is rejected by machinery that does not know it was generated.
 *
 * @module sweep/prompts
 */

import { change } from '@cycgraph/orchestrator';
import type { Change, Graph } from '@cycgraph/orchestrator';
import type { Finding } from '../insights/types.js';
import type { WorkflowProfile } from '../insights/profile.js';
import { RELIABILITY_SAMPLES, WORTH_OPTIMISING } from './knobs.js';
import type { KnobSweep } from './types.js';

/** Characters a generated prompt may hold. Longer is a runaway, not a prompt. */
const MAX_PROMPT_CHARS = 4000;

/** What a prompt rewrite is for, stated without proposing one. */
export interface PromptBrief {
  workflow: string;
  /** The node whose agent's prompt is in question. */
  nodeId: string;
  /**
   * Repair rewrites a prompt the workflow fails under; lean rewrites one it
   * succeeds under, spending less. The intent decides which prefixes the
   * sweep forks and what the verdict optimises, so it is part of the brief
   * rather than an option beside it.
   */
  intent: 'repair' | 'lean';
  /**
   * For repair: the failing assertions with their messages. For lean: the
   * checks the rewrite must keep passing.
   */
  evidence: string;
  reason: string;
}

/**
 * The brief a workflow's persistent failure motivates, when one does.
 *
 * Persistent, not intermittent: a workflow failing most runs is asking more
 * than the prompt reliably delivers, which prose might fix. One failing
 * sometimes is a sampling question and belongs to the temperature tier.
 *
 * The node is the one where most of the work happens, because the finding
 * names none. That is a heuristic and the brief says which node it chose, so
 * a reader can disagree before anything is spent.
 */
export function enumeratePromptBrief(
  findings: readonly Finding[],
  profile: WorkflowProfile | undefined,
  graph: Graph,
): PromptBrief | undefined {
  if (!profile) return undefined;

  const broken = findings.find(finding =>
    finding.workflow === profile.workflow
    && finding.detector === 'assertions'
    && finding.severity === 'high');
  if (!broken) return undefined;

  const target = profile.nodes.find(node => {
    const graphNode = graph.nodes.find(n => n.id === node.nodeId);
    return graphNode?.agent_id !== undefined && node.timeShare >= WORTH_OPTIMISING;
  });
  if (!target) return undefined;

  return {
    workflow: profile.workflow,
    nodeId: target.nodeId,
    intent: 'repair',
    evidence: broken.detail,
    reason: `the workflow fails its assertions in most runs (${broken.title}), so the question is whether a rewritten prompt makes '${target.nodeId}' produce what they check for`,
  };
}

/**
 * The brief a healthy but expensive node motivates, when one does.
 *
 * The mirror of repair: the workflow already does what its assertions ask,
 * and the question is whether a leaner prompt does the same for less. The
 * saving compounds wherever the prompt is re-sent — a supervisor pays its
 * prompt once per routing decision, a looped node once per visit — and a
 * rewrite that converges a loop in fewer visits shows up in the same
 * execution-time objective without being asked for by name.
 *
 * Yields to repair: a workflow that is broken should be fixed before it is
 * made cheaper, so a high-severity assertion finding silences this brief.
 */
export function enumerateLeanPromptBrief(
  findings: readonly Finding[],
  profile: WorkflowProfile | undefined,
  graph: Graph,
  checks: readonly string[],
): PromptBrief | undefined {
  if (!profile) return undefined;

  const broken = findings.some(finding =>
    finding.workflow === profile.workflow
    && finding.detector === 'assertions'
    && finding.severity === 'high');
  if (broken) return undefined;
  if (checks.length === 0) return undefined;

  const target = profile.nodes.find(node => {
    const graphNode = graph.nodes.find(n => n.id === node.nodeId);
    return graphNode?.agent_id !== undefined && node.timeShare >= WORTH_OPTIMISING;
  });
  if (!target) return undefined;

  return {
    workflow: profile.workflow,
    nodeId: target.nodeId,
    intent: 'lean',
    evidence: `the checks that must keep passing: ${[...checks].sort().join(', ')}`,
    reason: `'${target.nodeId}' takes ${Math.round(target.timeShare * 100)}% of execution time across ${target.visitsPerRun.toFixed(1)} visit(s) a run, so the question is whether a leaner prompt does the same work for less`,
  };
}

/**
 * The instructions handed to the generator.
 *
 * The failing assertions are given verbatim because they are the contract:
 * a prompt that instructs the agent to produce exactly what they check for is
 * a legitimate fix, not gaming — the assertions are what the workflow's
 * author said success means.
 */
export function renderPromptBrief(
  brief: PromptBrief,
  currentPrompt: string,
  count: number,
): string {
  const ask = brief.intent === 'repair'
    ? [
      `The workflow's own checks fail: ${brief.evidence}`,
      '',
      `Write ${count} alternative system prompt(s) for this agent that keep its role but make it reliably produce what the checks require. Each must stand alone as a complete system prompt.`,
    ]
    : [
      `The workflow already succeeds, and ${brief.evidence}. The prompt is paid for on every call this agent makes.`,
      '',
      `Write ${count} substantially leaner system prompt(s) for this agent: shorter and tighter, keeping its role, still producing everything the checks require. Each must stand alone as a complete system prompt.`,
    ];

  return [
    `Rewrite the system prompt of one agent inside a workflow. The agent's node is '${brief.nodeId}' in the workflow '${brief.workflow}'.`,
    '',
    'The current system prompt:',
    '---',
    currentPrompt,
    '---',
    '',
    ...ask,
    '',
    `Respond with JSON only, in the shape {"prompts": ["...", ...]} with exactly ${count} entr${count === 1 ? 'y' : 'ies'}.`,
  ].join('\n');
}

/**
 * What generator output must survive to become candidates.
 *
 * Deliberately structural, never semantic: empty, identical to the current
 * prompt, runaway length, or duplicated. Judging whether a candidate is any
 * *good* is the sweep's job, and doing it here would be the generator grading
 * its own work one step removed.
 */
export function sanitizePromptCandidates(
  currentPrompt: string,
  raw: unknown,
  count: number,
): string[] {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'object' && raw !== null && Array.isArray((raw as { prompts?: unknown }).prompts))
      ? (raw as { prompts: unknown[] }).prompts
      : [];

  const current = currentPrompt.trim();
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const prompt = entry.trim();
    if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) continue;
    if (prompt === current || seen.has(prompt)) continue;
    seen.add(prompt);
    candidates.push(prompt);
    if (candidates.length === count) break;
  }

  return candidates;
}

/**
 * The sweep a brief and its surviving candidates form.
 *
 * Always sampled, with the current prompt as the control arm, because a
 * prompt changes output distribution and single draws say nothing about one.
 * The intent picks the rest. Repair is a reliability sweep from failing
 * prefixes: Fisher's exact test decides whether a candidate passes
 * distinguishably more often than the control. Lean is a cost sweep from
 * clean prefixes: every sample of a candidate must hold every assertion —
 * the contract, unchanged — and the verdict is whether it removes enough of
 * the control's execution time.
 */
export function buildPromptSweep(
  brief: PromptBrief,
  currentPrompt: string,
  candidates: readonly string[],
): KnobSweep | undefined {
  if (candidates.length === 0) return undefined;

  const variants: Record<string, Change[]> = {
    'prompt=current': [change.prompt(brief.nodeId, currentPrompt)],
  };
  candidates.forEach((candidate, index) => {
    variants[`prompt=v${index + 1}`] = [change.prompt(brief.nodeId, candidate)];
  });

  const repair = brief.intent === 'repair';
  return {
    id: `sweep:${brief.workflow}:${brief.nodeId}:prompt`,
    workflow: brief.workflow,
    nodeId: brief.nodeId,
    knob: 'prompt',
    current: 'current',
    objective: repair ? 'reliability' : 'cost',
    prefixes: repair ? 'failing' : 'clean',
    reason: brief.reason,
    variants,
    control: 'prompt=current',
    samples: RELIABILITY_SAMPLES,
  };
}

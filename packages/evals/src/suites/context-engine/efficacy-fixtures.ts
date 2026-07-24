/**
 * Context-Engine Efficacy Fixtures
 *
 * Shared scenarios for measuring compression EFFICACY — information
 * fidelity at a given compression ratio. Each scenario is a realistic
 * multi-segment agent context seeded with:
 *
 * - `criticalFacts`: substrings that must survive compression verbatim
 *   (entities, quantities, dates, identifiers). Used by the deterministic
 *   fact-survival track.
 * - `negations`: negation words whose loss would invert meaning.
 * - `qaProbes`: question/answer pairs derivable from the original,
 *   judged against the compressed output by the LLM semantic track.
 *
 * The noise around the planted facts is deliberately compressible:
 * duplicated findings across segments (dedup fodder), reasoning traces
 * (CoT distillation fodder), and filler-heavy prose (pruning fodder).
 * Efficacy = the noise goes, the facts stay.
 *
 * @module suites/context-engine/efficacy-fixtures
 */

import type { PromptSegment, BudgetConfig, PipelinePreset } from '@cycgraph/context-engine';

export interface QaProbe {
  /** Question answerable from the original context. */
  question: string;
  /** Reference answer (must be derivable from the original). */
  answer: string;
}

export interface EfficacyScenario {
  name: string;
  description: string;
  segments: PromptSegment[];
  budget: BudgetConfig;
  /** Substrings that must survive compression verbatim. */
  criticalFacts: string[];
  /** Negation words that must survive (meaning inversion guard). */
  negations: string[];
  /** QA probes for the LLM-judged answerability track. */
  qaProbes: QaProbe[];
  /**
   * Presets gated on this scenario in the deterministic track. Presets
   * outside their intended domain are measured (efficacy runner) but not
   * gated — e.g. `fast` has no pruning or CoT distillation, so trailing
   * facts in prose die to allocator tail-truncation by design.
   */
  gatePresets: PipelinePreset[];
  /** Minimum reduction percent the gated presets must achieve. */
  minReductionPercent: number;
}

// ─── Scenario 1: research session (prose-heavy) ────────────────────
//
// A multi-agent research session: two agents wrote overlapping findings
// (cross-segment duplicates), one output contains a reasoning trace, and
// the prose is filler-heavy. Critical facts are single-token-ish
// (identifiers, amounts, dates, names) so survival is checkable verbatim.

const RESEARCH_HISTORY = [
  '<think>Let me carefully consider the vendor options. First we should look at pricing across all three vendors. Then we need to consider the compliance requirements. After weighing all of these factors against each other at length. Therefore: MERIDIAN-7 is the recommended vendor platform.</think>',
  'It should be noted that in order to reach a decision, the team essentially had to basically evaluate the entire vendor landscape in terms of the overall pricing and compliance posture.',
  'The recommended platform is MERIDIAN-7, proposed by Vasquez on 2026-03-14.',
  'The total contract value is $1,284,500 over three years.',
  'Deployment must never bypass the compliance sandbox during rollout.',
].join('\n\n');

const AGENT_A_NOTES = [
  'Multi-vendor comparisons show integration costs dominate the first year of any platform migration.',
  'The rateLimiter component needs a dedicated capacity review before the pilot begins.',
  'Support SLAs from the shortlisted vendors range from 4 to 24 hours for critical incidents.',
].join('\n\n');

const AGENT_B_NOTES = [
  'Multi-vendor comparisons show integration costs dominate the first year of any platform migration.',
  'Support SLAs from the shortlisted vendors range from 4 to 24 hours for critical incidents.',
  'Procurement flagged that legal review adds roughly six weeks to vendor onboarding timelines.',
].join('\n\n');

const RESEARCH_SESSION: EfficacyScenario = {
  name: 'research_session',
  description: 'Prose-heavy multi-agent session: CoT trace + cross-segment duplicates + filler prose around planted facts',
  segments: [
    {
      id: 'system',
      content: 'You are a procurement analyst. Summarize vendor recommendations for leadership.',
      role: 'system',
      priority: 10,
      locked: true,
    },
    { id: 'history', content: RESEARCH_HISTORY, role: 'history', priority: 5 },
    { id: 'agent_a', content: AGENT_A_NOTES, role: 'custom', priority: 3 },
    { id: 'agent_b', content: AGENT_B_NOTES, role: 'custom', priority: 3 },
  ],
  // Calibrated: tight enough that noise must go (~35% reduction at this
  // budget), loose enough that every planted fact fits. All presets gated:
  // the allocator's importance-aware truncation preserves trailing facts
  // even for `fast` (which has no CoT distillation or pruning of its own) —
  // before that fix, `fast` measured 2/5 facts at budgets up to 320.
  budget: { maxTokens: 260, outputReserve: 0 },
  criticalFacts: ['MERIDIAN-7', '$1,284,500', '2026-03-14', 'Vasquez', 'rateLimiter'],
  negations: ['never'],
  gatePresets: ['fast', 'balanced', 'maximum'],
  minReductionPercent: 25,
  qaProbes: [
    { question: 'Which vendor platform is recommended?', answer: 'MERIDIAN-7' },
    { question: 'What is the total contract value?', answer: '$1,284,500 over three years' },
    { question: 'Who proposed the recommendation, and when?', answer: 'Vasquez, on 2026-03-14' },
    { question: 'What must the deployment never do during rollout?', answer: 'Bypass the compliance sandbox' },
  ],
};

// ─── Scenario 2: structured memory payload (JSON) ──────────────────
//
// A workflow-state memory blackboard as JSON. Structured content must be
// reshaped (format stage), never token-pruned — every value should survive
// the JSON -> compact conversion.

const MEMORY_PAYLOAD = {
  workflow: { id: 'wf-migration-042', status: 'running', phase: 'pilot' },
  candidates: [
    { vendor: 'MERIDIAN-7', score: 92, sla_hours: 4, compliant: true },
    { vendor: 'Northgate', score: 87, sla_hours: 12, compliant: true },
    { vendor: 'Coreline', score: 71, sla_hours: 24, compliant: false },
  ],
  decision: {
    approved_by: 'Vasquez',
    approved_on: '2026-03-14',
    contract_value_usd: 1284500,
  },
};

const STRUCTURED_MEMORY: EfficacyScenario = {
  name: 'structured_memory',
  description: 'JSON memory blackboard: format conversion must preserve every record and value',
  segments: [
    {
      id: 'system',
      content: 'You are a workflow supervisor. Route the next step from workflow state.',
      role: 'system',
      priority: 10,
      locked: true,
    },
    {
      id: 'memory',
      content: JSON.stringify(MEMORY_PAYLOAD, null, 2),
      role: 'memory',
      priority: 5,
    },
  ],
  budget: { maxTokens: 400, outputReserve: 0 },
  criticalFacts: [
    'wf-migration-042',
    'MERIDIAN-7',
    'Northgate',
    'Coreline',
    '92',
    '87',
    '71',
    'Vasquez',
    '2026-03-14',
    '1284500',
  ],
  negations: [],
  qaProbes: [
    { question: 'Which vendor scored highest, and what was the score?', answer: 'MERIDIAN-7, with a score of 92' },
    { question: 'Which vendor is not compliant?', answer: 'Coreline' },
    { question: 'What is the contract value in USD?', answer: '1284500' },
  ],
  // Structured content is the fast preset's home turf — all presets gated.
  gatePresets: ['fast', 'balanced', 'maximum'],
  minReductionPercent: 25,
};

/** All efficacy scenarios, shared by the deterministic and semantic tracks. */
export const EFFICACY_SCENARIOS: EfficacyScenario[] = [
  RESEARCH_SESSION,
  STRUCTURED_MEMORY,
];

/** Join a scenario's mutable (compressible) content for judging. */
export function joinSegments(segments: PromptSegment[]): string {
  return segments
    .filter(s => !s.locked)
    .map(s => s.content)
    .join('\n\n');
}

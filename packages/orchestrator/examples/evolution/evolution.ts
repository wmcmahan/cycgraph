/**
 * Evolution (DGM) — Runnable Example
 *
 * Population-based Darwinian selection: generate N candidates in parallel, score
 * them, keep the best, and breed the next generation from the winner — and the
 * scorer's critique of it — until the output can't be improved.
 *
 * The hard part of *demonstrating* evolution is that a capable model one-shots
 * any task you can fully describe in a prompt — there's no room left to improve.
 * So this example scores candidates with a DETERMINISTIC fitness built around
 * something models genuinely can't nail in one pass: an exact character + word
 * count. They can't count characters, so a first attempt lands a few off, and
 * each generation reads the previous best plus the "you're at 53 chars, target
 * 55" feedback and converges closer. Unlike an LLM judge, it's reproducible.
 *
 * A realistic note on what you'll see: a strong model writes a near-spec tagline
 * almost immediately (generation 0 ~0.95), so the visible climb is short — it
 * improves a step or two, then either nails the spec or stalls at a local
 * optimum (e.g. stuck one character short), at which point stagnation detection
 * stops the run. The *size* of the climb scales with how hard the target is for
 * the model; a dramatic many-generation climb needs a task that's genuinely hard
 * across the board (verifiable code, hard search, real optimization), which is
 * beyond what a tagline demo can show. What this example does show end-to-end is
 * the full loop: a diverse parallel population, selection of the best, feedback-
 * driven refinement, elitism (the curve never dips), and early stopping.
 *
 * (For the LLM-as-judge variant — scoring subjective quality with an evaluator
 * agent — set `evaluator_agent_id` on the node and drop `fitnessFunction`. Just
 * know that on a strong model a simple judged task tends to ace generation 0.)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evolution/evolution.ts
 */

import {
  GraphRunner,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createGraph,
  createWorkflowState,
  createLogger,
} from '@cycgraph/orchestrator';
import type { FitnessFunction } from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evolution/evolution.ts');
  process.exit(1);
}

const logger = createLogger('example.evolution');

// ─── 1. The spec + deterministic fitness ─────────────────────────────────
// A "fits-on-a-button" tagline: an EXACT length and word count, while staying
// on-message. The two exact targets are the forcing function — a model can't
// nail both in one shot, so generation 0 scores partial and has to converge.

const TARGET_CHARS = 55;
const TARGET_WORDS = 8;
const BANNED = /\b(seamless|powerful|robust|revolutionary|leverage|unlock|supercharge|cutting[- ]edge|next[- ]generation|world[- ]class)\b/i;

/** The spec, shown to the writer so it knows the target it must converge to. */
const SPEC = [
  `1. Exactly ${TARGET_CHARS} characters long (count them — the closer, the better).`,
  `2. Exactly ${TARGET_WORDS} words.`,
  '3. Mentions crash durability / recovery (e.g. "survives crashes", "recovers").',
  '4. Mentions agents or workflows.',
  '5. Uses none of these filler words: seamless, powerful, robust, revolutionary, leverage, unlock, supercharge, cutting-edge, next-generation, world-class.',
].join('\n');

/** Continuous closeness score in [0,1]: 1 when `value === target`, fading to 0 at `±span`. */
const closeness = (value: number, target: number, span: number) =>
  Math.max(0, 1 - Math.abs(value - target) / span);

const fitnessFunction: FitnessFunction = async (output) => {
  const raw = (output as { candidate_output?: unknown })?.candidate_output;
  const tagline = (typeof raw === 'string' ? raw : '').trim().replace(/^["']|["']$/g, '');

  const chars = tagline.length;
  const words = tagline.split(/\s+/).filter(Boolean).length;

  // Tight spans: the score only nears 1.0 within ~1 char and ~1 word of target,
  // so a candidate must actually CONVERGE on the exact counts — a lucky-but-not-
  // exact first attempt scores ~0.95, leaving a generation or two of climb.
  const charScore = closeness(chars, TARGET_CHARS, 12);
  const wordScore = closeness(words, TARGET_WORDS, 4);
  const durability = /\b(crash|durab|recover|surviv|restart)/i.test(tagline) ? 1 : 0;
  const agents = /\b(agent|workflow)/i.test(tagline) ? 1 : 0;
  const noFiller = BANNED.test(tagline) ? 0 : 1;

  const score = (charScore + wordScore + durability + agents + noFiller) / 5;

  // The reasoning becomes `_evolution_parent_reasoning` for the next generation,
  // so spell out exactly what to fix.
  const reasoning = [
    `length ${chars}/${TARGET_CHARS} chars (${charScore.toFixed(2)})`,
    `words ${words}/${TARGET_WORDS} (${wordScore.toFixed(2)})`,
    `durability ${durability ? 'MET' : 'MISSING'}`,
    `agents/workflows ${agents ? 'MET' : 'MISSING'}`,
    `filler ${noFiller ? 'none' : 'PRESENT — remove it'}`,
  ].join('; ');

  return { score, reasoning };
};

// ─── 2. Register the candidate agent ─────────────────────────────────────
// No evaluator agent — the deterministic fitness above does the scoring.

const registry = new InMemoryAgentRegistry();

const CANDIDATE_ID = registry.register({
  name: 'Tagline Writer',
  description: 'Writes and refines a tagline toward an exact length/word spec',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You write a single product tagline that must hit this spec exactly:',
    SPEC,
    '',
    'The data block may contain two keys from the previous generation:',
    '  - `_evolution_parent`: the best tagline so far.',
    '  - `_evolution_parent_reasoning`: its score breakdown, e.g. "length 63/55 chars".',
    'When present, EDIT the parent toward the spec: if it is too long, cut words or',
    'shorten them; if too short, add a word; preserve the parts already marked MET.',
    'Aim for the exact character and word counts — count carefully.',
    'If no parent is present, write a strong first attempt.',
    '',
    'Output ONLY the tagline text — no preamble, no quotes, no commentary.',
  ].join('\n'),
  temperature: 0.9, // Overridden by evolution temperature annealing (explore → exploit)
  max_steps: 2,
  tools: [],
  permissions: {
    read_keys: ['*'],
    write_keys: ['candidate_output'],
  },
});

configureAgentFactory(registry);
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 3. Define the graph ─────────────────────────────────────────────────
// A single evolution node handles the full generational loop internally.

const graph = createGraph({
  name: 'Tagline Evolution',
  description: 'Converge a tagline onto an exact length/word spec across generations',

  nodes: [
    {
      id: 'evolve',
      type: 'evolution',
      agent_id: CANDIDATE_ID,
      read_keys: ['*'],
      write_keys: ['*'],
      evolution_config: {
        candidate_agent_id: CANDIDATE_ID,
        // No evaluator_agent_id — scoring comes from the injected fitnessFunction.

        // Modest population — the value here is iterative convergence, not
        // brute-forcing the exact counts with one huge first batch.
        population_size: 4,
        max_generations: 6,
        // Elitism: carry the single best candidate forward unchanged each round.
        // This guarantees the fitness curve never dips — so you see a clean,
        // monotonic climb — and saves one candidate generation per round.
        elite_count: 1,

        // Stop once a candidate is essentially on-spec, OR once progress stalls.
        // A strong model lands near-spec almost immediately, so the interesting
        // behavior is the convergence that follows — and stagnation detection
        // exits cleanly when the best can't be improved for 3 rounds (a local
        // optimum) rather than padding the run with flat generations.
        fitness_threshold: 0.98,
        stagnation_generations: 3,

        selection_strategy: 'rank',

        // Explore wording broadly early, refine late. We keep a little late-stage
        // exploration (0.5, not near-0) to give the search a chance to escape a
        // local optimum — e.g. nudging a 53-char phrasing to the exact 55.
        initial_temperature: 1.0,
        final_temperature: 0.5,

        max_concurrency: 4,
        error_strategy: 'best_effort',
        task_timeout_ms: 30_000,
      },
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
  ],

  edges: [],
  start_node: 'evolve',
  end_nodes: ['evolve'],
});

// ─── 4. Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting evolution example — converging a tagline onto an exact spec...\n');

  const state = createWorkflowState({
    workflow_id: graph.id,
    goal: 'Write a tagline for "cycgraph", an engine for AI agent workflows that survive crashes and recover automatically.',
    constraints: [`Exactly ${TARGET_CHARS} characters`, `Exactly ${TARGET_WORDS} words`],
    max_execution_time_ms: 300_000,
  });

  // The deterministic scorer is injected here, the same way you'd inject an
  // LLM-judge-backed scorer or any other fitness implementation.
  const runner = new GraphRunner(graph, state, { fitnessFunction });

  try {
    const finalState = await runner.run();

    console.log('\n═══ Evolution Results ═══');
    console.log('Status:', finalState.status);

    const winnerOutput = finalState.memory['evolve_winner'] as { candidate_output?: string } | undefined;
    const winner = winnerOutput?.candidate_output ?? '(no winner produced)';
    const winnerFitness = finalState.memory['evolve_winner_fitness'] as number | undefined;
    const winnerReasoning = finalState.memory['evolve_winner_reasoning'] as string | undefined;
    const fitnessHistory = finalState.memory['evolve_fitness_history'] as number[] | undefined;

    if (fitnessHistory && fitnessHistory.length > 0) {
      console.log('\nFitness climbed as the tagline converged on the spec (best per generation):');
      let prev: number | undefined;
      fitnessHistory.forEach((score, gen) => {
        const bar = '█'.repeat(Math.round(score * 40));
        const delta =
          prev === undefined
            ? ''
            : score > prev
              ? `  ↑ +${(score - prev).toFixed(2)}`
              : score < prev
                ? `  ↓ ${(score - prev).toFixed(2)}`
                : '  ·';
        console.log(`  Gen ${gen + 1}: ${score.toFixed(2)}  ${bar}${delta}`);
        prev = score;
      });

      // Explain why the loop ended: hit the spec, or stalled at a local optimum.
      const best = winnerFitness ?? fitnessHistory[fitnessHistory.length - 1];
      console.log(
        best >= 0.98
          ? '  → reached the spec.'
          : '  → stopped before the spec: the best candidate plateaued at a local optimum the model could not improve on.',
      );
    }

    const finalChars = winner.trim().replace(/^["']|["']$/g, '').length;
    console.log('\nWinning tagline', winnerFitness !== undefined ? `(fitness ${winnerFitness.toFixed(2)}, ${finalChars} chars):` : ':');
    console.log(`  ${winner}`);
    if (winnerReasoning) {
      console.log(`\n  Scorecard: ${winnerReasoning}`);
    }

    console.log(`\nTokens used: ${finalState.total_tokens_used}`);
    console.log(`Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();

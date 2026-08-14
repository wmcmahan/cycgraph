/**
 * Evolution — population-based selection with a deterministic scorer.
 *
 * Generates N candidates per generation, scores them, breeds the next
 * generation from the winner and the scorer's critique, and stops on the
 * fitness threshold, stagnation, or the generation cap.
 *
 * Run:  CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/evolution/evolution.ts
 * See:  ./README.md for why the scorer is deterministic and what climb to expect.
 */

import {
  agent,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryAgentRegistry,
  createLogger,
  evolution,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';
import type { FitnessFunction } from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example.evolution');

// ─── 1. The spec + deterministic fitness ─────────────────────────────────

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

  // Spans are tight on purpose: only within ~1 char and ~1 word of target does
  // the score near 1.0, so a near-miss still leaves a generation or two to climb.
  const charScore = closeness(chars, TARGET_CHARS, 12);
  const wordScore = closeness(words, TARGET_WORDS, 4);
  const durability = /\b(crash|durab|recover|surviv|restart)/i.test(tagline) ? 1 : 0;
  const agents = /\b(agent|workflow)/i.test(tagline) ? 1 : 0;
  const noFiller = BANNED.test(tagline) ? 0 : 1;

  const score = (charScore + wordScore + durability + agents + noFiller) / 5;

  // The reasoning becomes `parent_reasoning` in the next generation's Task
  // Context, so spell out exactly what to fix.
  const reasoning = [
    `length ${chars}/${TARGET_CHARS} chars (${charScore.toFixed(2)})`,
    `words ${words}/${TARGET_WORDS} (${wordScore.toFixed(2)})`,
    `durability ${durability ? 'MET' : 'MISSING'}`,
    `agents/workflows ${agents ? 'MET' : 'MISSING'}`,
    `filler ${noFiller ? 'none' : 'PRESENT — remove it'}`,
  ].join('; ');

  return { score, reasoning };
};

// ─── 2. Define the candidate agent ───────────────────────────────────────

const candidate = agent({
  name: 'Tagline Writer',
  description: 'Writes and refines a tagline toward an exact length/word spec',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You write a single product tagline that must hit this spec exactly:',
    SPEC,
    '',
    'The Task Context section may contain two keys from the previous generation:',
    '  - `parent`: the best tagline so far.',
    '  - `parent_reasoning`: its score breakdown, e.g. "length 63/55 chars".',
    'When present, EDIT the parent toward the spec: if it is too long, cut words or',
    'shorten them; if too short, add a word; preserve the parts already marked MET.',
    'Aim for the exact character and word counts — count carefully.',
    'If no parent is present, write a strong first attempt.',
    '',
    'Output ONLY the tagline text — no preamble, no quotes, no commentary.',
  ].join('\n'),
  temperature: 0.9, // Overridden by evolution temperature annealing (explore → exploit)
  maxSteps: 2,
});

// ─── 3. Place the agent in an evolution node + graph ─────────────────────
// One node runs the whole generational loop internally.

const evolve = evolution(candidate, {
  id: 'evolve',
  reads: ['*'],
  // No evaluator: scoring comes from the injected fitnessFunction.
  populationSize: 4,
  maxGenerations: 6,
  eliteCount: 1,
  fitnessThreshold: 0.98,
  stagnationGenerations: 3,
  selection: 'rank',

  // Final temperature stays at 0.5 rather than near-zero, leaving enough
  // late exploration to escape a local optimum a character short.
  initialTemperature: 1.0,
  finalTemperature: 0.5,

  concurrency: 4,
  onError: 'best_effort',
  taskTimeoutMs: 30_000,
  failurePolicy: { maxRetries: 2, maxBackoffMs: 30_000 },
});

const workflow = graph({
  name: 'Tagline Evolution',
  description: 'Converge a tagline onto an exact length/word spec across generations',
  nodes: [evolve],
  edges: [],
  startNode: evolve,
  endNodes: [evolve],
});

// The write ceiling is re-pinned to `candidate_output` deliberately. A facade
// agent() carries no permissions, and the evolution executor runs candidates as
// synthetic nodes granted write_keys ['*'], so this agent-config ceiling is the
// only thing routing a candidate's text to the key the scorer reads.
const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) {
  registry.register({ ...config, permissions: { readKeys: ['*'], writeKeys: ['candidate_output'] } });
}

// ─── 4. Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting evolution example — converging a tagline onto an exact spec...\n');

  const initialState = state({
    workflowId: workflow.id,
    goal: 'Write a tagline for "cycgraph", an engine for AI agent workflows that survive crashes and recover automatically.',
    constraints: [`Exactly ${TARGET_CHARS} characters`, `Exactly ${TARGET_WORDS} words`],
    maxExecutionTimeMs: 300_000,
  });

  const runner = new GraphRunner(workflow, initialState, { registry, fitnessFunction, providers: exampleProviders() });

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

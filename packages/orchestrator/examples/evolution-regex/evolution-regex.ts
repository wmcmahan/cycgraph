/**
 * Evolution with deterministic fitness — evolve a regex matching HTTP 4xx
 * except 401, 403, and 404. Scoring runs the candidate against fixed test
 * cases, so there is no judge variance and no scoring tokens.
 *
 * Run:  CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/evolution-regex/evolution-regex.ts
 * See:  ./README.md for why the exclusion list makes this hard.
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

const logger = createLogger('example.evolution-regex');

// ─── 1. The test corpus — fitness is computed against this ──────────────

// HTTP 4xx status codes EXCEPT 401, 403, 404.
const SHOULD_MATCH = [
  '400',  // Bad Request
  '402',  // Payment Required
  '405',  // Method Not Allowed
  '406',  // Not Acceptable
  '408',  // Request Timeout
  '409',  // Conflict
  '410',  // Gone
  '418',  // I'm a teapot
  '422',  // Unprocessable Entity
  '429',  // Too Many Requests
  '451',  // Unavailable For Legal Reasons
  '499',  // Client Closed Request
];

const SHOULD_REJECT = [
  // The famous three — the exclusion list
  '401',  // Unauthorized
  '403',  // Forbidden
  '404',  // Not Found
  // Non-4xx codes
  '200',  // OK
  '301',  // Moved Permanently
  '500',  // Internal Server Error
  '304',  // Not Modified
  '100',  // Continue
  // Structural failures
  '4000', // too long
  '40',   // too short
  'xyz',  // not numeric
];

// ─── 2. Deterministic fitness — no LLM judge ────────────────────────────

const fitnessFunction: FitnessFunction = async (output) => {
  // The candidate agent writes to `candidate_output`.
  const raw = (output as { candidate_output?: unknown })?.candidate_output;
  const candidate = typeof raw === 'string' ? raw.trim() : '';

  // Strip common LLM wrappers: backticks, "regex:" labels.
  const cleaned = candidate
    .replace(/^```(?:regex|text)?\s*/i, '')
    .replace(/```$/, '')
    .replace(/^regex:\s*/i, '')
    .replace(/^\/(.+)\/[gimsuy]*$/, '$1')
    .trim();

  let regex: RegExp;
  try {
    regex = new RegExp(cleaned);
  } catch {
    return {
      score: 0,
      reasoning: `Invalid regex: ${cleaned}`,
    };
  }

  let hits = 0;
  const detail: string[] = [];

  for (const s of SHOULD_MATCH) {
    if (regex.test(s)) { hits++; detail.push(`✓ match  ${s}`); }
    else                 detail.push(`✗ match  ${s}`);
  }
  for (const s of SHOULD_REJECT) {
    if (!regex.test(s)) { hits++; detail.push(`✓ reject ${s}`); }
    else                  detail.push(`✗ reject ${s}`);
  }

  const total = SHOULD_MATCH.length + SHOULD_REJECT.length;
  return {
    score: hits / total,
    reasoning: `Pattern: ${cleaned}\n${detail.join('\n')}`,
  };
};

// ─── 3. Define the candidate agent ──────────────────────────────────────
// The evaluator is the deterministic function above — no evaluator agent needed.

const candidate = agent({
  name: 'Regex Generator',
  description: 'Generates regex candidates that match HTTP 4xx codes except 401, 403, 404',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are an expert at writing regular expressions in JavaScript.',
    'Output ONLY a single regex pattern as plain text — no backticks, no explanation, no labels.',
    'You must match HTTP 4xx status codes (exactly three digits, 400 through 499).',
    'You must NOT match 401, 403, or 404 — these three specific codes are excluded.',
    'You must NOT match: codes outside the 4xx range, codes with more or fewer than 3 digits, or non-numeric content.',
    'If a parent pattern is provided in the Task Context section (from a previous generation), study it carefully along with `parent_reasoning` which lists exactly which tests passed (✓) and failed (✗).',
    'Use the per-test failures to make a TARGETED change — fix the failing tests without breaking the passing ones.',
    'Anchors (^ and $) are usually needed.',
  ].join(' '),
  temperature: 0.9, // overridden by evolution temperature annealing
  maxSteps: 1,
});

// ─── 4. Place the agent in an evolution node + graph ────────────────────
// `candidateAgentId` accepts the agent() value directly — graph() deep-resolves
// it to the same registry id the node's `agent` field mints, so it registers once.

const evolve = evolution(candidate, {
  id: 'evolve',
  reads: ['*'],
  // evaluatorAgentId intentionally omitted — fitnessFunction handles scoring.
  populationSize: 4,
  maxGenerations: 4,
  eliteCount: 1,
  // Threshold deliberately set above 1.0 so the loop never exits
  // early. Modern LLMs (Haiku, Sonnet, Opus) one-shot the canonical
  // regex even for unusual exclusion patterns, which would terminate
  // the loop on generation 0 and prove nothing about the engine
  // actually iterating. By running all max_generations we get
  // visible proof that parent context is propagated, temperature
  // anneals, and the parallel fan-out fires every generation.
  fitnessThreshold: 1.5,
  // Stagnation also disabled so identical-fitness generations
  // don't trigger early exit.
  stagnationGenerations: 99,
  selection: 'rank',
  initialTemperature: 1.0,
  finalTemperature: 0.3,
  concurrency: 4,
  onError: 'best_effort',
  taskTimeoutMs: 30_000,
  failurePolicy: { maxRetries: 2, maxBackoffMs: 30_000 },
});

const workflow = graph({
  name: 'Regex Evolution',
  description: 'Evolve a regex that matches HTTP 4xx status codes except 401, 403, and 404',
  nodes: [evolve],
  edges: [],
  startNode: evolve,
  endNodes: [evolve],
});

// The graph carries the agent() config; register it into a run-scoped registry
// for the explicit GraphRunner path. We re-pin the write ceiling to
// `candidate_output`: a facade agent() is a pure capability (permissions null),
// but the evolution executor runs each candidate as a synthetic node granted
// write_keys ['*'], so the agent-config ceiling is the only thing that routes a
// candidate's text to `candidate_output` — the key the fitnessFunction and the
// winner blob read.
const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) {
  registry.register({ ...config, permissions: { readKeys: ['*'], writeKeys: ['candidate_output'] } });
}

// ─── 5. Run ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting evolution-regex example — evolving an HTTP 4xx matcher (excluding 401, 403, 404)\n');

  console.log('═══ Target corpus ═══');
  console.log('Should MATCH:');
  for (const s of SHOULD_MATCH) console.log(`  ✓ ${s}`);
  console.log('Should REJECT:');
  for (const s of SHOULD_REJECT) console.log(`  ✗ ${s}`);
  console.log('');

  const initialState = state({
    workflowId: workflow.id,
    goal: 'Match HTTP 4xx status codes (400-499) except 401, 403, and 404; reject everything else',
    maxExecutionTimeMs: 180_000,
  });

  const runner = new GraphRunner(workflow, initialState, { registry, fitnessFunction, providers: exampleProviders() });

  try {
    const finalState = await runner.run();

    console.log('═══ Evolution Results ═══');
    console.log('Status:', finalState.status);

    const winnerOutput = finalState.memory['evolve_winner'] as { candidate_output?: string } | undefined;
    const winnerFitness = finalState.memory['evolve_winner_fitness'];
    const winnerReasoning = finalState.memory['evolve_winner_reasoning'] as string | undefined;
    const fitnessHistory = finalState.memory['evolve_fitness_history'] as number[] | undefined;

    console.log('\nWinning regex:');
    console.log(`  ${winnerOutput?.candidate_output ?? '(none)'}`);
    console.log(`  Fitness: ${winnerFitness}`);

    if (fitnessHistory) {
      console.log('\nFitness history (best per generation):');
      fitnessHistory.forEach((score, gen) => {
        const bar = '█'.repeat(Math.round(score * 40));
        console.log(`  Gen ${gen + 1}: ${score.toFixed(3)} ${bar}`);
      });
    }

    if (winnerReasoning) {
      console.log('\nPer-test detail for the winner:');
      console.log(winnerReasoning.split('\n').slice(1).map((l) => `  ${l}`).join('\n'));
    }

    console.log(`\nTokens used: ${finalState.total_tokens_used}`);
    console.log(`Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
    console.log('\n(Fitness scoring used a deterministic function — no LLM judge tokens.)');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();

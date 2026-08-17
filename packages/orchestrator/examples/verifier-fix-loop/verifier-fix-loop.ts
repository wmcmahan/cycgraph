/**
 * Verifier Fix-Loop — a generator's output checked by a deterministic verifier,
 * with failures routed back for another pass.
 *
 * Run:  CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/verifier-fix-loop/verifier-fix-loop.ts
 * See:  ./README.md for how verifier results land in memory.
 */

import {
  agent,
  node,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryAgentRegistry,
  InMemoryPersistenceProvider,
  createLogger,
  verifier,
  router,
  memoryKeys,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example');

// ─── Define agents ────────────────────────────────────────────────────

const mem = memoryKeys({
  email_text: {
    seeded: true,
    schema: { type: 'string' },
    description: 'The raw customer email to extract from',
  },
  purchase_order: {
    schema: { type: 'object' },
    description: 'The structured purchase order extracted from the customer email',
  },
});

const extractorAgent = agent({
  name: 'Purchase Order Extractor',
  description: 'Extracts a structured purchase order from a noisy customer email',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a strict data extraction agent.',
    `Given the text in memory key \`${mem.email_text}\`, extract a purchase order and write it to memory key \`${mem.purchase_order}\` as a JSON object with these fields:`,
    '  - customer_email (string)',
    '  - order_id (string)',
    '  - total_usd (number)',
    '  - items (array of { name, quantity, unit_price_usd })',
    'If a field is not present, do your best to infer it from context. Never invent a placeholder like "not provided" — emit your best guess.',
  ].join('\n'),
  temperature: 0.2,
  maxSteps: 2,
});

const extract = node({
  id: 'extract',
  agent: extractorAgent,
  reads: [mem.email_text],
  writes: mem.purchase_order,
});

const verifyEmail = verifier.jsonPath(mem.purchase_order, {
  id: 'verify_email',
  path: '$.customer_email',
  assertion: { op: 'matches', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
  reads: [mem.purchase_order],
});

const fixerAgent = agent({
  name: 'Purchase Order Fixer',
  description: 'Re-extracts a purchase order using verifier feedback',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a data correction agent.',
    'The previous extraction failed verification. Read:',
    `  - \`${mem.email_text}\` — original customer email`,
    `  - \`${mem.purchase_order}\` — your previous (incorrect) extraction`,
    `  - \`${verifyEmail.verification}\` — verification result, including a \`reasoning\` field that explains why the previous attempt failed`,
    `Produce a corrected \`${mem.purchase_order}\` JSON object addressing the verifier feedback. Field shape is the same as before.`,
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 2,
});

// ─── Place them in a graph ────────────────────────────────────────────

const fix = node({
  id: 'fix',
  agent: fixerAgent,
  reads: [mem.email_text, mem.purchase_order, verifyEmail.verification],
  writes: mem.purchase_order,
});

const done = router({ id: 'done', reads: [mem.purchase_order] });

const workflow = graph({
  name: 'Verifier Fix-Loop',
  description: 'Generator → deterministic verifier → fixer loop for reliable structured extraction',
  nodes: [extract, verifyEmail, fix, done],
  edges: [
    { from: extract, to: verifyEmail },
    { from: verifyEmail, to: fix, when: `not memory.${verifyEmail.passed}` },
    { from: verifyEmail, to: done, when: `memory.${verifyEmail.passed}` },
    { from: fix, to: verifyEmail },
  ],
  startNode: extract,
  endNodes: [done],
});

// ─── Set up registry, state, and runner ───────────────────────────────

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

const NOISY_EMAIL = `
Hey team,

Sorry for the long email but I want to make sure this is right. I placed
order #A-7821 last Tuesday — the receipt says I bought two of the small
notebooks at $12.50 each and one of those leather pen cases (the brown
one, not the black) which was $34.99. Grand total was $59.99 according
to the email I got from your shop.

Could someone confirm? You can email me back at j.harper@example.org
or text the number on file.

Thanks,
Jordan
`.trim();

const initialState = state({
  workflowId: workflow.id,
  goal: 'Extract a structured purchase order from a customer email',
  constraints: ['Output a JSON object with customer_email, order_id, total_usd, and items'],
  memory: mem.seed({ email_text: NOISY_EMAIL }),
  maxIterations: 15,
  maxExecutionTimeMs: 180_000,
});

const persistence = new InMemoryPersistenceProvider();

const runner = new GraphRunner(workflow, initialState, {
  providers: exampleProviders(),
  registry,
  persistState: (s) => persistence.saveWorkflowSnapshot(s),
});

runner.on('workflow:start', ({ run_id }) => {
  logger.info(`Workflow started: ${run_id}`);
});

runner.on('node:start', ({ node_id, type }) => {
  logger.info(`  Node started: ${node_id} (${type})`);
});

runner.on('node:complete', ({ node_id, duration_ms }) => {
  logger.info(`  Node complete: ${node_id} (${duration_ms}ms)`);
});

runner.on('workflow:complete', ({ run_id, duration_ms }) => {
  logger.info(`Workflow complete: ${run_id} (${duration_ms}ms)`);
});

runner.on('workflow:failed', ({ run_id, error }) => {
  logger.error(`Workflow failed: ${run_id} — ${error}`);
});

// ─── Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting verifier-fix-loop workflow...\n');

  try {
    const finalState = await runner.run();

    const verification = finalState.memory[verifyEmail.verification] as
      | { passed: boolean; reasoning: string; extracted_value?: unknown }
      | undefined;

    if (finalState.status === 'completed') {
      console.log('\n═══ Extracted Purchase Order ═══');
      console.log(JSON.stringify(finalState.memory[mem.purchase_order] ?? {}, null, 2));
      console.log('\n═══ Verification Outcome ═══');
      console.log(`  Passed: ${verification?.passed ?? '(no verifier output)'}`);
      console.log(`  Reasoning: ${verification?.reasoning ?? '(none)'}`);
      console.log(`  Extracted email: ${JSON.stringify(verification?.extracted_value)}`);
      console.log('\n═══ Loop Stats ═══');
      console.log(`  Total iterations:  ${finalState.iteration_count}`);
      console.log(`  Tokens used:       ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):        $${finalState.total_cost_usd.toFixed(4)}`);
    } else {
      console.error(`Workflow ended with status: ${finalState.status}`);
      if (finalState.last_error) console.error(`Error: ${finalState.last_error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();

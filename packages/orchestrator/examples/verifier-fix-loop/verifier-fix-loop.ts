/**
 * Verifier Fix-Loop — Runnable Example (authoring facade)
 *
 * A 3-node compound-systems workflow demonstrating the
 * generator → verifier → fixer loop:
 *
 *   extract       (LLM generator: noisy email → structured purchase order)
 *      ↓ always
 *   verify_email  (deterministic JSONPath verifier on the extracted email)
 *      ↓ passed == false
 *   fix           (LLM fixer: re-extracts with verifier feedback)
 *      ↓ always
 *   verify_email  (loop)
 *
 * When the verifier passes, no outgoing edge matches and the workflow
 * terminates naturally. The deterministic verifier ensures the final
 * output meets a structural invariant even when the generator misses
 * on the first try — the heart of the compound-systems pattern.
 *
 * Authored with the facade vocabulary (`agent` / `node` / `graph`), then run
 * through an explicit GraphRunner because the example inspects the final
 * WorkflowState (verification outcome, iteration count, cost) and attaches
 * event listeners, which the one-call `run()` helper does not expose.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/verifier-fix-loop/verifier-fix-loop.ts
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
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/verifier-fix-loop/verifier-fix-loop.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Define agents ────────────────────────────────────────────────────
// An agent() value is a capability: model, instructions, sampling. No id
// (graph() mints one) and no permissions (the node's grants are authoritative).

const extractorAgent = agent({
  name: 'Purchase Order Extractor',
  description: 'Extracts a structured purchase order from a noisy customer email',
  model: 'claude-sonnet-4-6',
  instructions: [
    'You are a strict data extraction agent.',
    'Given the text in memory key `email_text`, extract a purchase order and write it to memory key `purchase_order` as a JSON object with these fields:',
    '  - customer_email (string)',
    '  - order_id (string)',
    '  - total_usd (number)',
    '  - items (array of { name, quantity, unit_price_usd })',
    'If a field is not present, do your best to infer it from context. Never invent a placeholder like "not provided" — emit your best guess.',
  ].join('\n'),
  temperature: 0.2,
  maxSteps: 2,
});

const fixerAgent = agent({
  name: 'Purchase Order Fixer',
  description: 'Re-extracts a purchase order using verifier feedback',
  model: 'claude-sonnet-4-6',
  instructions: [
    'You are a data correction agent.',
    'The previous extraction failed verification. Read:',
    '  - `email_text` — original customer email',
    '  - `purchase_order` — your previous (incorrect) extraction',
    '  - `verify_email_verification` — verification result, including a `reasoning` field that explains why the previous attempt failed',
    'Produce a corrected `purchase_order` JSON object addressing the verifier feedback. Field shape is the same as before.',
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 2,
});

// ─── 2. Place them in a graph ────────────────────────────────────────────
// A verifier node has no agent: it runs a deterministic JSONPath assertion.
// Its result keys are an implied write grant, so no `writes` is declared —
// only `reads` for the target key it inspects.

const extract = node({
  id: 'extract',
  agent: extractorAgent,
  reads: ['email_text', 'goal'],
  writes: 'purchase_order',
});

const verifyEmail = node({
  id: 'verify_email',
  type: 'verifier',
  verifierConfig: {
    type: 'jsonpath',
    targetKey: 'purchase_order',
    path: '$.customer_email',
    // A real email has at least one `@` and one `.`, no whitespace.
    // Catches model outputs like "not provided", null, or junk strings.
    assertion: { op: 'matches', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
  },
  // The verifier's target_key must be readable; its result keys are implied.
  reads: ['purchase_order'],
});

const fix = node({
  id: 'fix',
  agent: fixerAgent,
  reads: ['email_text', 'purchase_order', 'verify_email_verification', 'goal'],
  writes: 'purchase_order',
});

// The verifier's success path is implicit: when it passes, no outgoing edge
// matches and the runner completes the workflow. That means every node has an
// outbound edge, so end nodes cannot be inferred — pass them explicitly.
const workflow = graph({
  name: 'Verifier Fix-Loop',
  description: 'Generator → deterministic verifier → fixer loop for reliable structured extraction',
  nodes: [extract, verifyEmail, fix],
  edges: [
    // Always: extract → verify
    { from: extract, to: verifyEmail },
    // Failure path: verify → fix
    { from: verifyEmail, to: fix, when: 'memory.verify_email_verification_passed == false' },
    // Loop: fix → verify
    { from: fix, to: verifyEmail },
  ],
  startNode: extract,
  endNodes: [],
});

// ─── 3. Set up registry, state, and runner ───────────────────────────────
// The graph carries its agent() configs; register them into a run-scoped
// registry for the explicit GraphRunner path.

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

// A deliberately noisy customer email. The model usually gets this right on
// the first try, but failures (placeholder strings, transposed digits in the
// total, missing email) are exactly what the verifier loop is designed to
// catch.
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
  memory: { email_text: NOISY_EMAIL },
  maxIterations: 15,
  maxExecutionTimeMs: 180_000,
});

const persistence = new InMemoryPersistenceProvider();

const runner = new GraphRunner(workflow, initialState, {
  registry,
  persistState: (s) => persistence.saveWorkflowSnapshot(s),
});

// Event listeners — verification events are the most interesting signal here.
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

// ─── 4. Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting verifier-fix-loop workflow...\n');

  try {
    const finalState = await runner.run();

    const verification = finalState.memory.verify_email_verification as
      | { passed: boolean; reasoning: string; extracted_value?: unknown }
      | undefined;

    if (finalState.status === 'completed') {
      console.log('\n═══ Extracted Purchase Order ═══');
      console.log(JSON.stringify(finalState.memory.purchase_order ?? {}, null, 2));
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

/**
 * Verifier Fix-Loop — Runnable Example
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
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/verifier-fix-loop/verifier-fix-loop.ts
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createLogger,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/verifier-fix-loop/verifier-fix-loop.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────

const registry = new InMemoryAgentRegistry();

const EXTRACTOR_ID = registry.register({
  name: 'Purchase Order Extractor',
  description: 'Extracts a structured purchase order from a noisy customer email',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a strict data extraction agent.',
    'Given the text in memory key `email_text`, extract a purchase order and write it to memory key `purchase_order` as a JSON object with these fields:',
    '  - customer_email (string)',
    '  - order_id (string)',
    '  - total_usd (number)',
    '  - items (array of { name, quantity, unit_price_usd })',
    'If a field is not present, do your best to infer it from context. Never invent a placeholder like "not provided" — emit your best guess.',
  ].join('\n'),
  temperature: 0.2,
  max_steps: 2,
  tools: [],
  permissions: {
    read_keys: ['email_text', 'goal'],
    write_keys: ['purchase_order'],
  },
});

const FIXER_ID = registry.register({
  name: 'Purchase Order Fixer',
  description: 'Re-extracts a purchase order using verifier feedback',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a data correction agent.',
    'The previous extraction failed verification. Read:',
    '  - `email_text` — original customer email',
    '  - `purchase_order` — your previous (incorrect) extraction',
    '  - `verify_email_verification` — verification result, including a `reasoning` field that explains why the previous attempt failed',
    'Produce a corrected `purchase_order` JSON object addressing the verifier feedback. Field shape is the same as before.',
  ].join('\n'),
  temperature: 0.3,
  max_steps: 2,
  tools: [],
  permissions: {
    read_keys: ['email_text', 'purchase_order', 'verify_email_verification', 'goal'],
    write_keys: ['purchase_order'],
  },
});

configureAgentFactory(registry);

const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────

const graph = createGraph({
  name: 'Verifier Fix-Loop',
  description: 'Generator → deterministic verifier → fixer loop for reliable structured extraction',

  nodes: [
    {
      id: 'extract',
      type: 'agent',
      agent_id: EXTRACTOR_ID,
      read_keys: ['email_text', 'goal'],
      write_keys: ['purchase_order'],
    },
    {
      id: 'verify_email',
      type: 'verifier',
      verifier_config: {
        type: 'jsonpath',
        target_key: 'purchase_order',
        path: '$.customer_email',
        // A real email has at least one `@` and one `.`, no whitespace.
        // Catches model outputs like "not provided", null, or junk strings.
        assertion: { op: 'matches', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
      },
      // verifier_config.target_key must be readable; result keys must be writable.
      read_keys: ['purchase_order'],
      write_keys: ['verify_email_verification', 'verify_email_verification_passed'],
    },
    {
      id: 'fix',
      type: 'agent',
      agent_id: FIXER_ID,
      read_keys: ['email_text', 'purchase_order', 'verify_email_verification', 'goal'],
      write_keys: ['purchase_order'],
    },
  ],

  edges: [
    // Always: extract → verify
    { source: 'extract', target: 'verify_email' },

    // Failure path: verify → fix
    {
      source: 'verify_email',
      target: 'fix',
      condition: {
        type: 'conditional',
        condition: 'memory.verify_email_verification_passed == false',
      },
    },

    // Loop: fix → verify
    { source: 'fix', target: 'verify_email' },

    // Success path is implicit: when the verifier passes, no outgoing edge
    // matches and the runner completes the workflow automatically.
  ],

  start_node: 'extract',
  end_nodes: [],
});

// ─── 3. Create initial state ─────────────────────────────────────────────

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

const initialState = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Extract a structured purchase order from a customer email',
  constraints: ['Output a JSON object with customer_email, order_id, total_usd, and items'],
  memory: { email_text: NOISY_EMAIL },
  max_iterations: 15,
  max_execution_time_ms: 180_000,
});

// ─── 4. Set up persistence + runner ──────────────────────────────────────

const persistence = new InMemoryPersistenceProvider();

const runner = new GraphRunner(graph, initialState, {
  persistStateFn: async (state) => {
    await persistence.saveWorkflowState(state);
    await persistence.saveWorkflowRun(state);
  },
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

// ─── 5. Run ──────────────────────────────────────────────────────────────

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

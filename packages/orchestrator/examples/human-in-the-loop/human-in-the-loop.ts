/**
 * Human-in-the-Loop — Runnable Example
 *
 * A 3-node linear workflow with an approval gate: a Writer agent
 * produces a draft, a human reviewer approves or rejects it, and
 * a Publisher agent finalizes the output.
 *
 * Demonstrates: approval gates, workflow pausing/resuming,
 * human review data, rejection routing, and the HITL resume flow.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts
 */

import * as readline from 'node:readline/promises';
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  ProviderRegistry,
  registerBuiltInProviders,
  configureProviderRegistry,
  createLogger,
  createGraph,
  createWorkflowState,
  type HumanResponse,
  type WorkflowState,
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────
// register() returns the auto-generated UUID for each agent.

const registry = new InMemoryAgentRegistry();

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  description: 'Produces a draft article on a given topic',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a professional writer.',
    'Given a goal, produce a clear and engaging draft article.',
    'Keep it under 300 words. Use plain language.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints'],
    writeKeys: ['draft'],
  },
});

const PUBLISHER_ID = registry.register({
  name: 'Publisher Agent',
  description: 'Finalizes and formats an approved draft for publication',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a publishing editor.',
    'Take the approved draft and produce a final version with a headline,',
    'proper formatting, and a brief author attribution.',
    'Incorporate any feedback from the human reviewer if provided.',
  ].join(' '),
  temperature: 0.4,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'draft', 'human_response', 'human_decision'],
    writeKeys: ['published'],
  },
});
configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = new ProviderRegistry();
registerBuiltInProviders(providers);
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────
// Linear: write → review (approval gate) → publish
// The approval gate pauses the workflow until a human approves or rejects.

const graph = createGraph({
  name: 'Human-in-the-Loop',
  description: 'Write → Human Review → Publish with approval gate',

  nodes: [
    {
      id: 'write',
      type: 'agent',
      agentId: WRITER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['draft'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'review',
      type: 'approval',
      approvalConfig: {
        approvalType: 'human_review',
        promptMessage: 'Please review the draft before publication.',
        reviewKeys: ['draft'],
        timeoutMs: 300_000, // 5 minutes
      },
      readKeys: ['*'],
      writeKeys: ['*', 'control_flow'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 1000 },
      requiresCompensation: false,
    },
    {
      id: 'publish',
      type: 'agent',
      agentId: PUBLISHER_ID,
      readKeys: ['goal', 'draft', 'human_response', 'human_decision'],
      writeKeys: ['published'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
  ],

  edges: [
    { source: 'write', target: 'review' },
    { source: 'review', target: 'publish' },
  ],

  startNode: 'write',
  endNodes: ['publish'],
});

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState = createWorkflowState({
  workflowId: graph.id,
  goal: 'Write a short article explaining why open-source software matters for innovation.',
  constraints: ['Keep the draft under 300 words', 'Use plain language suitable for a general audience'],
  maxExecutionTimeMs: 600_000,
});

// ─── 4. Set up persistence + runner ──────────────────────────────────────

const persistence = new InMemoryPersistenceProvider();

function createRunner(state: WorkflowState): GraphRunner {
  const runner = new GraphRunner(graph, state, {
    persistStateFn: async (s) => {
      await persistence.saveWorkflowState(s);
      await persistence.saveWorkflowRun(s);
    },
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

  runner.on('workflow:waiting', ({ waiting_for }) => {
    logger.info(`Workflow paused — waiting for: ${waiting_for}`);
  });

  runner.on('workflow:complete', ({ run_id, duration_ms }) => {
    logger.info(`Workflow complete: ${run_id} (${duration_ms}ms)`);
  });

  runner.on('workflow:failed', ({ run_id, error }) => {
    logger.error(`Workflow failed: ${run_id} — ${error}`);
  });

  return runner;
}

// ─── 5. Interactive prompt ───────────────────────────────────────────────

async function promptHuman(draft: string): Promise<HumanResponse> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     HUMAN REVIEW REQUIRED                ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log('Draft for review:\n');
    console.log(draft);
    console.log('\n──────────────────────────────────────────');

    const answer = await rl.question('\nApprove this draft? (yes/no): ');
    const approved = answer.trim().toLowerCase().startsWith('y');

    if (approved) {
      const feedback = await rl.question('Any feedback for the publisher? (press Enter to skip): ');
      return {
        decision: 'approved',
        data: feedback || 'Approved without changes.',
      };
    } else {
      const reason = await rl.question('Reason for rejection: ');
      return {
        decision: 'rejected',
        data: reason || 'Rejected by reviewer.',
      };
    }
  } finally {
    rl.close();
  }
}

// ─── 6. Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting human-in-the-loop workflow...\n');

  try {
    // Phase 1: Run until the approval gate pauses the workflow
    const runner1 = createRunner(initialState);
    const pausedState = await runner1.run();

    if (pausedState.status !== 'waiting') {
      console.error(`Expected workflow to pause, but got status: ${pausedState.status}`);
      process.exit(1);
    }

    // Show the pending approval details
    const pending = pausedState.memory._pending_approval as {
      prompt_message: string;
      review_data: Record<string, unknown>;
    };
    console.log(`\nApproval gate prompt: "${pending.prompt_message}"`);

    // Phase 2: Human reviews the draft interactively
    const draft = (pending.review_data.draft as string) ?? '(no draft)';
    const humanResponse = await promptHuman(draft);

    console.log(`\nReviewer decision: ${humanResponse.decision}`);

    if (humanResponse.decision === 'rejected') {
      console.log('\n═══ Workflow Rejected ═══');
      console.log(`Reason: ${humanResponse.data}`);
      console.log('In production, this would route to a revision node.');
      console.log('\n═══ Stats ═══');
      console.log(`  Nodes visited:  ${pausedState.visited_nodes.join(' → ')}`);
      console.log(`  Tokens used:    ${pausedState.total_tokens_used}`);
      console.log(`  Cost (USD):     $${(pausedState.total_cost_usd ?? 0).toFixed(4)}`);
      return;
    }

    // Phase 3: Resume the workflow with the human's approval
    const runner2 = createRunner({ ...pausedState });
    runner2.applyHumanResponse(humanResponse);

    const finalState = await runner2.run();

    if (finalState.status === 'completed') {
      console.log('\n═══ Draft (pre-review) ═══');
      console.log(finalState.memory.draft ?? '(none)');
      console.log('\n═══ Human Decision ═══');
      console.log(finalState.memory.human_decision ?? '(none)');
      console.log(`Feedback: ${finalState.memory.human_response ?? '(none)'}`);
      console.log('\n═══ Published Article ═══');
      console.log(finalState.memory.published ?? '(none)');
      console.log('\n═══ Stats ═══');
      console.log(`  Nodes visited:  ${finalState.visited_nodes.join(' → ')}`);
      console.log(`  Tokens used:    ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):     $${finalState.total_cost_usd.toFixed(4)}`);
    } else {
      console.error(`Workflow ended with status: ${finalState.status}`);
      if (finalState.last_error) {
        console.error(`Error: ${finalState.last_error}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();

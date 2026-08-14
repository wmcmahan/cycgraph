/**
 * Human-in-the-Loop — Runnable Example (authoring facade)
 *
 * A 3-node linear workflow with an approval gate: a Writer agent
 * produces a draft, a human reviewer approves or rejects it, and
 * a Publisher agent finalizes the output.
 *
 * Demonstrates: approval gates, workflow pausing/resuming,
 * human review data, rejection routing, and the HITL resume flow.
 *
 * Authored with the facade vocabulary (`agent` / `node` / `graph`), then run
 * through an explicit GraphRunner because the pause/resume flow inspects the
 * paused WorkflowState and builds a second runner over it, which the one-call
 * `run()` helper does not expose.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts
 */

import * as readline from 'node:readline';
import {
  agent,
  node,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  createLogger,
  type HumanResponse,
  type WorkflowState,
  approval,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Define agents ────────────────────────────────────────────────────
// An agent() value is a capability: model, instructions, sampling. No id
// (graph() mints one) and no permissions (the node's grants are authoritative).

const writerAgent = agent({
  name: 'Writer Agent',
  description: 'Produces a draft article on a given topic',
  model: MODEL,
    provider: PROVIDER,
  instructions: [
    'You are a professional writer.',
    'Given a goal, produce a clear and engaging draft article.',
    'Keep it under 300 words. Use plain language.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
});

const publisherAgent = agent({
  name: 'Publisher Agent',
  description: 'Finalizes and formats an approved draft for publication',
  model: MODEL,
    provider: PROVIDER,
  instructions: [
    'You are a publishing editor.',
    'Take the approved draft and produce a final version with a headline,',
    'proper formatting, and a brief author attribution.',
    'Incorporate any feedback from the human reviewer if provided.',
  ].join(' '),
  temperature: 0.4,
  maxSteps: 3,
});

// ─── 2. Define the graph ─────────────────────────────────────────────────
// Linear: write → review (approval gate) → publish
// The approval gate pauses the workflow until a human approves or rejects.

const write = node({
  id: 'write',
  agent: writerAgent,
  reads: ['goal', 'constraints'],
  writes: 'draft',
  failurePolicy: { maxRetries: 2 },
});

// `control_flow` is an implied grant on an approval node: pausing for a human
// is what the type does, so it needs no declaration.
const review = approval({
  id: 'review',
  prompt: 'Please review the draft before publication.',
  reviewKeys: ['draft'],
  timeoutMs: 300_000, // 5 minutes
  reads: ['*'],
  writes: ['*'],
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 1000 },
});

const publish = node({
  id: 'publish',
  agent: publisherAgent,
  reads: ['goal', 'draft', 'human_response', 'human_decision'],
  writes: 'published',
  failurePolicy: { maxRetries: 2 },
});

// Start/end are inferred (write has no inbound edge, publish has no outbound).
const workflow = graph({
  name: 'Human-in-the-Loop',
  description: 'Write → Human Review → Publish with approval gate',
  nodes: [write, review, publish],
  edges: [
    { from: write, to: review },
    { from: review, to: publish },
  ],
});

// ─── 3. Set up registry and initial state ────────────────────────────────
// The graph carries its agent() configs; register them into a run-scoped
// registry for the explicit GraphRunner path.

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

const initialState = state({
  workflowId: workflow.id,
  goal: 'Write a short article explaining why open-source software matters for innovation.',
  constraints: ['Keep the draft under 300 words', 'Use plain language suitable for a general audience'],
  maxExecutionTimeMs: 600_000,
});

// ─── 4. Set up persistence + runner ──────────────────────────────────────

const persistence = new InMemoryPersistenceProvider();

function createRunner(workflowState: WorkflowState): GraphRunner {
  const runner = new GraphRunner(workflow, workflowState, {
  providers: exampleProviders(),
    registry,
    persistState: async (s) => {
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

/**
 * Line-queue prompter over stdin.
 *
 * `readline.question()` alone loses input when stdin is a pipe: lines that
 * arrive between two questions are emitted with no listener armed and are
 * silently dropped, and when stdin hits EOF while a question is pending the
 * promise never settles — the event loop drains and the process exits 0
 * mid-workflow. This wrapper buffers every line as it arrives and rejects
 * pending asks on EOF, so both `printf 'yes\n\n' | tsx ...` and interactive
 * terminal use behave correctly.
 */
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const buffered: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  let closed = false;

  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      // Interactive terminals echo typed input natively; echo piped input
      // ourselves so the transcript shows the consumed answer either way.
      if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
      waiter.resolve(line);
    } else {
      buffered.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error('stdin closed before an answer was received'));
    }
  });

  return {
    ask(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const queued = buffered.shift();
      if (queued !== undefined) {
        if (!process.stdin.isTTY) process.stdout.write(`${queued}\n`);
        return Promise.resolve(queued);
      }
      if (closed) {
        return Promise.reject(new Error('stdin closed before an answer was received'));
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close(): void {
      rl.close();
    },
  };
}

async function promptHuman(draft: string): Promise<HumanResponse> {
  const prompter = createPrompter();

  try {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     HUMAN REVIEW REQUIRED                ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log('Draft for review:\n');
    console.log(draft);
    console.log('\n──────────────────────────────────────────');

    const answer = await prompter.ask('\nApprove this draft? (yes/no): ');
    const approved = answer.trim().toLowerCase().startsWith('y');

    if (approved) {
      const feedback = await prompter.ask('Any feedback for the publisher? (press Enter to skip): ');
      return {
        decision: 'approved',
        data: feedback || 'Approved without changes.',
      };
    } else {
      const reason = await prompter.ask('Reason for rejection: ');
      return {
        decision: 'rejected',
        data: reason || 'Rejected by reviewer.',
      };
    }
  } finally {
    prompter.close();
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
    const pending = pausedState.pending_approval as {
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

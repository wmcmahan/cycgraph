/**
 * Voting / Consensus — Runnable Example (authoring facade)
 *
 * Multiple agents independently vote on a decision. A strategy aggregates
 * the results (majority vote, weighted vote, or LLM judge).
 *
 * This example uses 3 voter agents with different expertise areas to
 * evaluate a technical proposal, then aggregates via majority vote.
 *
 * Demonstrates: voting node, parallel agent execution, majority vote
 * aggregation, quorum enforcement, and per-task timeout.
 *
 * Authored with the facade vocabulary (`agent` / `node` / `graph`). The
 * voting node takes the agent() values directly on `voterAgentIds` — graph()
 * deep-resolves them to registry ids. It runs through an explicit GraphRunner
 * because the example inspects the final WorkflowState (status, token/cost
 * totals), which the one-call `run()` helper does not expose.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/voting/voting.ts
 */

import {
  agent,
  node,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryAgentRegistry,
  createLogger,
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/voting/voting.ts');
  process.exit(1);
}

const logger = createLogger('example.voting');

// ─── 1. Define voter agents ──────────────────────────────────────────────
// Each voter has a different perspective/expertise to provide diverse opinions.

const securityVoter = agent({
  name: 'Security Reviewer',
  description: 'Reviews proposals from a security perspective',
  model: 'claude-sonnet-4-6',
  instructions: [
    'You are a security expert reviewing a technical proposal.',
    'Evaluate the proposal for security implications: authentication, authorization,',
    'data protection, injection risks, and compliance.',
    'Your output must be a JSON object: { "decision": "approve" | "reject", "reasoning": "..." }',
  ].join(' '),
  temperature: 0.3,
  maxSteps: 3,
});

const performanceVoter = agent({
  name: 'Performance Reviewer',
  description: 'Reviews proposals from a performance perspective',
  model: 'claude-sonnet-4-6',
  instructions: [
    'You are a performance engineer reviewing a technical proposal.',
    'Evaluate for scalability, latency impact, resource usage, and efficiency.',
    'Your output must be a JSON object: { "decision": "approve" | "reject", "reasoning": "..." }',
  ].join(' '),
  temperature: 0.3,
  maxSteps: 3,
});

const architectureVoter = agent({
  name: 'Architecture Reviewer',
  description: 'Reviews proposals from an architecture perspective',
  model: 'claude-sonnet-4-6',
  instructions: [
    'You are a software architect reviewing a technical proposal.',
    'Evaluate for design patterns, maintainability, extensibility, and technical debt.',
    'Your output must be a JSON object: { "decision": "approve" | "reject", "reasoning": "..." }',
  ].join(' '),
  temperature: 0.3,
  maxSteps: 3,
});

// ─── 2. Define the graph ────────────────────────────────────────────────
// A single voting node handles parallel execution and aggregation internally.
// The agent() voters sit directly on voterAgentIds; graph() resolves them.

const reviewVote = node({
  id: 'review-vote',
  type: 'voting',
  reads: ['*'],
  writes: ['*'],
  votingConfig: {
    voterAgentIds: [securityVoter, performanceVoter, architectureVoter],
    strategy: 'majority_vote',
    voteKey: 'vote',
    quorum: 2,            // At least 2 of 3 voters must respond
    taskTimeoutMs: 30_000, // Per-voter timeout
  },
  failurePolicy: { maxRetries: 2, maxBackoffMs: 30000 },
});

const workflow = graph({
  name: 'Technical Proposal Review',
  description: 'Multi-expert voting on a technical proposal',
  nodes: [reviewVote],
  edges: [],
  startNode: reviewVote,
  endNodes: [reviewVote],
});

// ─── 3. Set up registry, state, and runner ───────────────────────────────

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

// ─── 4. Run ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting voting example — multi-expert technical review...\n');

  const initialState = state({
    workflowId: workflow.id,
    goal: [
      'Review this proposal: "Replace our REST API with GraphQL federation.',
      'The migration would involve: (1) adding Apollo Gateway as a reverse proxy,',
      '(2) converting 47 REST endpoints to GraphQL resolvers over 6 sprints,',
      '(3) maintaining both APIs during a 3-month deprecation window,',
      '(4) adding field-level authorization via custom directives."',
      'Vote to approve or reject this proposal.',
    ].join(' '),
    constraints: ['Consider the full lifecycle cost, not just implementation'],
    maxExecutionTimeMs: 120_000,
  });

  const runner = new GraphRunner(workflow, initialState, { registry });

  try {
    const finalState = await runner.run();

    console.log('\n═══ Voting Results ═══');
    console.log('Status:', finalState.status);

    // Voting node outputs are stored with the node ID prefix
    const votes = finalState.memory['review-vote_votes'] as Array<{ agent_id: string; vote: unknown }> | undefined;
    const result = finalState.memory['review-vote_result'];

    if (votes) {
      console.log('\nIndividual Votes:');
      for (const v of votes) {
        console.log(`  ${v.agent_id}: ${JSON.stringify(v.vote)}`);
      }
    }

    console.log('\nAggregated Result:');
    console.log(JSON.stringify(result, null, 2));

    console.log(`\nTokens used: ${finalState.total_tokens_used}`);
    console.log(`Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();

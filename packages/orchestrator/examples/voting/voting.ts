/**
 * Voting — three specialists vote in parallel, a strategy aggregates.
 *
 * Run:  CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/voting/voting.ts
 * See:  ./README.md for quorum behaviour and the other strategies.
 */

import {
  agent,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryAgentRegistry,
  createLogger,
  voting,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example.voting');

// ─── Define voter agents ──────────────────────────────────────────────

const securityVoter = agent({
  name: 'Security Reviewer',
  description: 'Reviews proposals from a security perspective',
  model: MODEL,
  provider: PROVIDER,
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
  model: MODEL,
  provider: PROVIDER,
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
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a software architect reviewing a technical proposal.',
    'Evaluate for design patterns, maintainability, extensibility, and technical debt.',
    'Your output must be a JSON object: { "decision": "approve" | "reject", "reasoning": "..." }',
  ].join(' '),
  temperature: 0.3,
  maxSteps: 3,
});

// ─── Define the graph ────────────────────────────────────────────────

// `<id>_consensus` and `<id>_votes` are implied grants, so no writes here.
const reviewVote = voting([securityVoter, performanceVoter, architectureVoter], {
  id: 'review-vote',
  strategy: 'majority_vote',
  voteKey: 'vote',
  quorum: 2,             // At least 2 of 3 voters must respond
  taskTimeoutMs: 30_000, // Per-voter timeout
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

// ─── Set up registry, state, and runner ───────────────────────────────

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

// ─── Run ─────────────────────────────────────────────────────────────

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

  const runner = new GraphRunner(workflow, initialState, { registry, providers: exampleProviders() });

  try {
    const finalState = await runner.run();

    console.log('\n═══ Voting Results ═══');
    console.log('Status:', finalState.status);

    const votes = finalState.memory['review-vote_votes'] as Array<{ agent_id: string; vote: unknown }> | undefined;
    const result = finalState.memory['review-vote_consensus'];

    if (votes) {
      console.log('\nIndividual Votes:');
      for (const v of votes) {
        console.log(`  ${v.agent_id}: ${JSON.stringify(v.vote)}`);
      }
    }

    console.log('\nConsensus:');
    console.log(JSON.stringify(result, null, 2));

    console.log(`\nTokens used: ${finalState.total_tokens_used}`);
    console.log(`Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();

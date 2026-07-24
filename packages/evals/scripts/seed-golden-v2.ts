/**
 * Seed Golden Dataset v2
 *
 * Expands the golden dataset from 7 to 54 trajectories (18 per suite).
 * Generates trajectories programmatically across 6 categories per suite
 * with 3 trajectories per category.
 *
 * Usage:
 *   npx tsx scripts/seed-golden-v2.ts
 */

import { randomUUID } from 'node:crypto';
import { writeGoldenDataset } from '../src/dataset/writer.js';
import type { GoldenTrajectory } from '../src/dataset/types.js';

const now = new Date().toISOString();

// ─── Helper ──────────────────────────────────────────────────────

function t(
  suite: 'orchestrator' | 'context-engine' | 'memory',
  description: string,
  input: string,
  expectedOutput: string | Record<string, unknown>,
  tags: string[],
  expectedToolCalls?: GoldenTrajectory['expectedToolCalls'],
): GoldenTrajectory {
  return {
    id: randomUUID(),
    suite,
    description,
    input,
    expectedOutput,
    expectedToolCalls,
    tags,
    source: 'internal',
    createdAt: now,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Orchestrator Trajectories (18)
// ═══════════════════════════════════════════════════════════════════

const orchestratorTrajectories: GoldenTrajectory[] = [
  // --- Single-node linear (3) ---
  t('orchestrator', 'Single-node: research TypeScript history',
    'Research the history of TypeScript. Use the web_search tool exactly once to gather sources, then summarize what you found.',
    'TypeScript was created by Microsoft and first released in 2012. It was designed by Anders Hejlsberg to add static typing to JavaScript.',
    ['linear', 'basic'],
    [{ toolName: 'web_search', args: { query: 'history of TypeScript' } }]),
  t('orchestrator', 'Single-node: summarize document',
    'Summarize the following quarterly earnings report in 2-3 sentences: Revenue grew 15% year-over-year to $2.4B, driven by the cloud services division which grew 28%. Hardware sales declined 4%. Operating margin held steady at 22%, and guidance for next quarter projects 12-14% growth.',
    'The quarterly report shows revenue growth of 15% year-over-year with strong performance in the cloud services division.',
    ['linear', 'basic']),
  t('orchestrator', 'Single-node: translate text (no tools)',
    'Translate the following text to French: Hello, how are you today?',
    'Bonjour, comment allez-vous aujourd\'hui ?',
    ['linear', 'basic', 'no-tools'],
    []),

  // --- Branching/conditional (3) ---
  t('orchestrator', 'Branch: data quality routing',
    'If the data has errors, clean it; otherwise analyze it. Data quality profile: 500 rows; the price column contains 12 null values; the date column has 3 type mismatches (strings where dates are expected).',
    { branch: 'clean', reason: 'Data contains 12 null values and 3 type mismatches', action: 'Cleaned nulls via interpolation, fixed type casts' },
    ['branching', 'conditional']),
  t('orchestrator', 'Branch: sentiment-based routing',
    'Route the customer message to support if negative, to sales if positive. Customer message: "This is the third time my order arrived broken. I am extremely frustrated and want this fixed immediately."',
    { branch: 'support', reason: 'Sentiment score -0.7 indicates frustration', action: 'Escalated to tier-2 support' },
    ['branching', 'conditional']),
  t('orchestrator', 'Branch: approval threshold check',
    'If the estimated cost exceeds $10,000, require manager approval; otherwise auto-approve. Purchase order: 5 replacement laptops, estimated cost $7,500.',
    { branch: 'auto-approve', reason: 'Estimated cost $7,500 is below threshold', action: 'Purchase order auto-approved' },
    ['branching', 'conditional']),

  // --- Error/retry (3) ---
  t('orchestrator', 'Retry: unreliable API with backoff',
    'Attempt to fetch data from unreliable API',
    'Data fetched successfully after 2 retries. First attempt timed out at 5s, second returned 503, third succeeded with 200 OK.',
    ['error', 'retry']),
  t('orchestrator', 'Retry: rate limit handling',
    'Process a batch of API calls using the rate_limited_call tool. Keep calling it until it reports status "done", backing off and retrying whenever you receive a 429 rate-limit response. Once it reports done, stop calling the tool and report how many calls succeeded and how many rate-limit pauses occurred.',
    'Completed 5 calls with 2 rate-limit pauses. All responses received successfully.',
    ['error', 'retry']),
  t('orchestrator', 'Error: graceful degradation on tool failure',
    'Fetch the latest AI news using the flaky_fetch tool. If a call fails, retry it. As soon as one call succeeds, stop calling the tool entirely and summarize what it returned.',
    'Web search unavailable. Returning cached results from 2 hours ago: 5 articles about LLM advances.',
    ['error', 'retry']),

  // --- Multi-agent delegation (3) ---
  t('orchestrator', 'Delegation: research and writing team',
    'Coordinate research and writing team to produce a report on climate change',
    'Delegated research to Agent-R (3 sources found), writing to Agent-W (1500-word draft), review to Agent-V (2 revisions). Final report approved.',
    ['multi-agent', 'delegation'],
    [{ toolName: 'delegate_to_agent', args: { agent: 'research', task: 'Research climate change impacts' } }]),
  t('orchestrator', 'Delegation: code review pipeline',
    'Have the code agent write tests, then the review agent check coverage',
    'Code agent produced 12 test cases. Review agent found 85% branch coverage. Delegated back for 3 missing edge cases.',
    ['multi-agent', 'delegation'],
    [{ toolName: 'delegate_to_agent', args: { agent: 'code', task: 'Write unit tests' } }]),
  t('orchestrator', 'Delegation: parallel specialist agents',
    'Send this dataset to both the statistics agent and the visualization agent simultaneously: [23, 45, 31, 58, 39, 62, 41, 35, 49, 40]. The statistics agent computes summary stats; the visualization agent proposes charts.',
    'Statistics agent computed mean=42.3, median=39.0, std=12.1. Visualization agent generated 3 charts. Results merged into final dashboard.',
    ['multi-agent', 'delegation']),

  // --- Budget enforcement (3) ---
  t('orchestrator', 'Budget: complete within token limit',
    'Summarize the benefits of unit testing in under 150 words, staying within a 1000-token response budget.',
    'Task completed in 847 tokens. Budget utilization: 84.7%.',
    ['budget', 'limits']),
  t('orchestrator', 'Budget: cost ceiling enforcement',
    'Analyze the following dataset while staying under $0.50 in API costs: monthly sales figures [12000, 13500, 11800, 15200, 14100, 16800] for Jan-Jun. Report the trend and any outliers.',
    'Analysis complete. Cost: $0.38. Used smaller model for preprocessing, full model for final analysis only.',
    ['budget', 'limits']),
  t('orchestrator', 'Budget: early termination on budget exceeded',
    'Without using any tools, run an iterative improvement loop on this sentence, refining it up to 3 times while staying within a 500-token response budget: "AI is good and does many things for people." Report each iteration and stop early if the budget would be exceeded.',
    'Completed 3 of 5 planned iterations. Stopped at 487 tokens to avoid exceeding 500-token budget.',
    ['budget', 'limits']),

  // --- State persistence (3) ---
  t('orchestrator', 'State: save and resume intermediate results',
    'Without using any tools, simulate a 5-step pipeline that checkpoints intermediate results: run steps 1-3, save a checkpoint named "step-3" holding keys research_results and draft_outline, then resume from that checkpoint and finish steps 4-5. Report the checkpoint name, saved keys, and final step reached.',
    { checkpoint: 'step-3', state_keys: ['research_results', 'draft_outline'], resumed: true, final_step: 'step-5' },
    ['state', 'persistence']),
  t('orchestrator', 'State: workflow state round-trip through checkpoint',
    'Execute a 3-step pipeline, checkpoint after each step, verify state integrity',
    { steps_completed: 3, checkpoints: 3, state_integrity: 'verified', keys_preserved: ['input', 'step1_output', 'step2_output'] },
    ['state', 'persistence']),
  t('orchestrator', 'State: concurrent state writes with reducer merge',
    'Two parallel agents write to shared state, verify reducer merges correctly',
    { agents: ['agent-a', 'agent-b'], merge_strategy: 'reducer', conflicts: 0, final_keys: ['agent_a_result', 'agent_b_result'] },
    ['state', 'persistence']),
];

// ═══════════════════════════════════════════════════════════════════
// Context Engine Trajectories (18)
// ═══════════════════════════════════════════════════════════════════

const contextEngineTrajectories: GoldenTrajectory[] = [
  // --- Format compression (3) ---
  t('context-engine', 'Format: tabular JSON to TOON compression',
    JSON.stringify([
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
      { name: 'Carol', role: 'reviewer', score: 95 },
    ]),
    '@name @role @score\nAlice researcher 92\nBob writer 87\nCarol reviewer 95',
    ['format', 'json']),
  t('context-engine', 'Format: nested object compression',
    JSON.stringify({ workflow: { id: 'wf-1', status: 'running' }, config: { model: 'claude', temp: 0.7 } }),
    'workflow.id=wf-1 workflow.status=running config.model=claude config.temp=0.7',
    ['format', 'json']),
  t('context-engine', 'Format: flat key-value pairs stay compact',
    JSON.stringify({ name: 'Test', version: '1.0', active: true }),
    'name=Test version=1.0 active=true',
    ['format', 'json']),

  // --- Dedup (exact+fuzzy) (3) ---
  t('context-engine', 'Dedup: exact duplicate removal',
    'Multi-agent systems cost 5-10x more.\nLocal deployment is better.\nMulti-agent systems cost 5-10x more.',
    'Multi-agent systems cost 5-10x more.\nLocal deployment is better.',
    ['dedup', 'exact']),
  t('context-engine', 'Dedup: fuzzy near-duplicate detection',
    'Multi-agent systems cost 5-10x more than single-agent setups in production environments today.\nMulti-agent systems cost 5-10x more than single-agent setups in production environments now.',
    'Multi-agent systems cost 5-10x more than single-agent setups in production environments today.',
    ['dedup', 'fuzzy']),
  t('context-engine', 'Dedup: no false positives on distinct content',
    'TypeScript adds static typing to JavaScript.\nPython uses dynamic typing by default.\nRust enforces ownership at compile time.',
    'TypeScript adds static typing to JavaScript.\nPython uses dynamic typing by default.\nRust enforces ownership at compile time.',
    ['dedup', 'exact', 'fuzzy']),

  // --- Priority budget (3) ---
  t('context-engine', 'Budget: system prompt preserved under tight budget',
    JSON.stringify({ system: 'You are a helpful assistant.', memory: 'x'.repeat(2000) }),
    'System prompt preserved; memory truncated to fit 200-token budget.',
    ['priority', 'budget']),
  t('context-engine', 'Budget: locked segments never truncated',
    JSON.stringify({ locked: 'Critical safety instructions.', unlocked: 'Optional context '.repeat(100) }),
    'Locked segment preserved in full; unlocked segment compressed to fit budget.',
    ['priority', 'budget']),
  t('context-engine', 'Budget: priority ordering determines allocation',
    JSON.stringify({ high: 'Important findings about cost reduction.', low: 'Background noise data '.repeat(50) }),
    'High-priority segment allocated first; low-priority segment receives remaining budget.',
    ['priority', 'budget']),

  // --- Incremental caching (3) ---
  t('context-engine', 'Cache: unchanged segments reuse compressed output',
    JSON.stringify({ turn1: 'System prompt stays the same', turn2: 'System prompt stays the same' }),
    'Turn 2: cachedSegmentCount=1, freshSegmentCount=0',
    ['incremental', 'cache']),
  t('context-engine', 'Cache: changed segments recompressed',
    JSON.stringify({ turn1: 'Initial context', turn2: 'Updated context with new data' }),
    'Turn 2: cachedSegmentCount=0, freshSegmentCount=1',
    ['incremental', 'cache']),
  t('context-engine', 'Cache: mixed cached and fresh segments',
    JSON.stringify({ static: 'Stable system prompt', dynamic: 'Turn-specific user input' }),
    'Turn 2: cachedSegmentCount=1 (static), freshSegmentCount=1 (dynamic)',
    ['incremental', 'cache']),

  // --- Memory adaptive (3) ---
  t('context-engine', 'Adaptive: memory payload prioritized by recency',
    JSON.stringify({
      themes: [{ id: 't1', label: 'Architecture', fact_ids: ['f1'] }],
      facts: [{ id: 'f1', content: 'Uses graph engine', valid_from: '2026-01-15' }],
      episodes: [],
    }),
    'Themes grouped with facts; recent facts prioritized over older ones.',
    ['memory', 'adaptive']),
  t('context-engine', 'Adaptive: large memory payload compressed within budget',
    JSON.stringify({
      themes: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: `Theme ${i}`, fact_ids: [`f${i}`] })),
      facts: Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, content: `Fact number ${i} with details`, valid_from: '2026-01-01' })),
      episodes: [],
    }),
    'All 10 themes and facts compressed into budget-compliant output with hierarchy format.',
    ['memory', 'adaptive']),
  t('context-engine', 'Adaptive: empty memory payload produces minimal output',
    JSON.stringify({ themes: [], facts: [], episodes: [] }),
    'No memory available.',
    ['memory', 'adaptive']),

  // --- Multi-stage pipeline (3) ---
  t('context-engine', 'Pipeline: format+dedup+allocator end-to-end',
    JSON.stringify({ data: [{ x: 1 }, { x: 2 }, { x: 1 }] }),
    'Pipeline output: formatted, deduplicated, budget-allocated within 4096 tokens.',
    ['pipeline', 'multi-stage']),
  t('context-engine', 'Pipeline: CoT distillation + heuristic pruning',
    '<think>Long reasoning about optimization strategies and tradeoffs.</think>Key finding: compression saves 40-60% of tokens.',
    'Key finding: compression saves 40-60% of tokens.',
    ['pipeline', 'multi-stage']),
  t('context-engine', 'Pipeline: full 6-stage balanced preset',
    'Complex input with reasoning, duplicates, and verbose prose requiring all compression stages.',
    'Balanced pipeline achieves >= 30% token reduction with 6 stages.',
    ['pipeline', 'multi-stage']),
];

// ═══════════════════════════════════════════════════════════════════
// Memory Trajectories (18)
// ═══════════════════════════════════════════════════════════════════

const memoryTrajectories: GoldenTrajectory[] = [
  // --- Episode segmentation (3) ---
  t('memory', 'Segmentation: time-gap based episode splitting',
    JSON.stringify([
      { role: 'user', content: 'Tell me about the project', timestamp: '2026-01-01T10:00:00Z' },
      { role: 'assistant', content: 'The project uses a graph engine', timestamp: '2026-01-01T10:01:00Z' },
      { role: 'user', content: 'What about the budget?', timestamp: '2026-01-01T11:00:00Z' },
      { role: 'assistant', content: 'The budget is 100k', timestamp: '2026-01-01T11:01:00Z' },
    ]),
    { episodes: 2, reason: '1-hour gap exceeds 30-minute threshold' },
    ['segmentation', 'episodes']),
  t('memory', 'Segmentation: single conversation stays one episode',
    JSON.stringify([
      { role: 'user', content: 'Hello', timestamp: '2026-01-01T10:00:00Z' },
      { role: 'assistant', content: 'Hi there', timestamp: '2026-01-01T10:00:30Z' },
      { role: 'user', content: 'How are you?', timestamp: '2026-01-01T10:01:00Z' },
    ]),
    { episodes: 1, reason: 'All messages within 30-minute window' },
    ['segmentation', 'episodes']),
  t('memory', 'Segmentation: deterministic across multiple runs',
    JSON.stringify([
      { role: 'user', content: 'First topic', timestamp: '2026-01-01T09:00:00Z' },
      { role: 'assistant', content: 'Response to first', timestamp: '2026-01-01T09:01:00Z' },
      { role: 'user', content: 'Second topic', timestamp: '2026-01-01T12:00:00Z' },
      { role: 'assistant', content: 'Response to second', timestamp: '2026-01-01T12:01:00Z' },
    ]),
    { episodes: 2, deterministic: true },
    ['segmentation', 'episodes']),

  // --- Fact extraction (3) ---
  t('memory', 'Extraction: person and organization entities',
    'Alice works at Acme Corp as lead engineer.',
    { facts: ['Alice works at Acme Corp as lead engineer.'], entities: ['Alice', 'Acme Corp'] },
    ['extraction', 'rule-based']),
  t('memory', 'Extraction: multiple facts from multi-sentence input',
    'Bob manages the Widget Project. The project deadline is Q1 2026. Carol reviewed the latest milestone.',
    { fact_count: 3, entities: ['Bob', 'Widget Project', 'Carol'] },
    ['extraction', 'rule-based']),
  t('memory', 'Extraction: camelCase and acronym entity detection',
    'The graphRunner module uses the MCP protocol for tool orchestration.',
    { entities: ['graphRunner', 'MCP'], types: ['concept', 'concept'] },
    ['extraction', 'rule-based']),

  // --- Temporal validity (3) ---
  t('memory', 'Temporal: expired facts filtered at query time',
    JSON.stringify([
      { content: 'Current fact', valid_from: '2025-01-01', valid_until: undefined },
      { content: 'Expired fact', valid_from: '2025-01-01', valid_until: '2025-06-01' },
    ]),
    { filtered_count: 1, kept: ['Current fact'] },
    ['temporal', 'validity']),
  t('memory', 'Temporal: future facts not yet valid',
    JSON.stringify([
      { content: 'Current fact', valid_from: '2025-01-01' },
      { content: 'Future fact', valid_from: '2027-01-01' },
    ]),
    { filtered_count: 1, kept: ['Current fact'] },
    ['temporal', 'validity']),
  t('memory', 'Temporal: invalidated facts excluded by default',
    JSON.stringify([
      { content: 'Valid fact', invalidated_by: undefined },
      { content: 'Invalidated fact', invalidated_by: 'f-replacement' },
    ]),
    { filtered_count: 1, excluded: ['Invalidated fact'] },
    ['temporal', 'validity']),

  // --- Subgraph extraction (3) ---
  t('memory', 'Subgraph: 1-hop returns direct neighbors',
    JSON.stringify({ seed_entities: ['e-alice'], max_hops: 1 }),
    { entities: ['e-alice', 'e-acme'], relationships: ['works_at'] },
    ['subgraph', 'graph']),
  t('memory', 'Subgraph: 2-hop expands to full neighborhood',
    JSON.stringify({ seed_entities: ['e-alice'], max_hops: 2 }),
    { entities: ['e-alice', 'e-acme', 'e-bob', 'e-widget'], relationships: ['works_at', 'owns'] },
    ['subgraph', 'graph']),
  t('memory', 'Subgraph: expired relationships excluded',
    JSON.stringify({ seed_entities: ['e-alice'], max_hops: 1, valid_at: '2026-04-06T12:00:00Z' }),
    { entities: ['e-alice', 'e-acme'], excluded_relationships: ['manages (expired)'] },
    ['subgraph', 'graph']),

  // --- Consolidation+cascade (3) ---
  t('memory', 'Consolidation: empty store returns zero report',
    'Run consolidation on empty memory store',
    { factsDeduped: 0, factsDecayed: 0, episodesPruned: 0, totalReclaimed: 0 },
    ['consolidation', 'cascade']),
  t('memory', 'Consolidation: near-duplicate facts merged by embedding similarity',
    JSON.stringify({ facts: ['Alice works at Acme Corp.', 'Alice is employed by Acme Corp.'], embeddings: true }),
    { factsDeduped: 1, survivor: 'Alice works at Acme Corp.' },
    ['consolidation', 'cascade']),
  t('memory', 'Consolidation: theme fact_ids updated after dedup',
    JSON.stringify({ themes: [{ id: 't1', fact_ids: ['f1', 'f2'] }], duplicate_pair: ['f1', 'f2'] }),
    { themes_cleaned_up: 1, remaining_fact_ids: ['f1'] },
    ['consolidation', 'cascade']),

  // --- Conflict detection (3) ---
  t('memory', 'Conflict: negation detected between positive and negative facts',
    JSON.stringify({ factA: 'Alice works at Acme Corp.', factB: 'Alice does not work at Acme Corp.' }),
    { conflict_type: 'negation', confidence: 0.8 },
    ['conflict', 'negation']),
  t('memory', 'Conflict: temporal supersession detected',
    JSON.stringify({ factA: { content: 'Bob is a junior developer', valid_from: '2024-01-01' }, factB: { content: 'Bob is a senior developer', valid_from: '2026-01-01' } }),
    { conflict_type: 'supersession', confidence: 0.9 },
    ['conflict', 'negation']),
  t('memory', 'Conflict: no false positive on unrelated facts',
    JSON.stringify({ factA: 'Alice works at Acme Corp.', factB: 'The weather is sunny today.' }),
    { conflicts_detected: 0 },
    ['conflict', 'negation']),
];

// ─── Write All Datasets ────────────────────────────────────────────

console.log('Seeding golden datasets v2 (54 total trajectories)...\n');

writeGoldenDataset('orchestrator', orchestratorTrajectories, '2.0.0');
console.log(`  orchestrator: ${orchestratorTrajectories.length} trajectories`);

writeGoldenDataset('context-engine', contextEngineTrajectories, '2.0.0');
console.log(`  context-engine: ${contextEngineTrajectories.length} trajectories`);

writeGoldenDataset('memory', memoryTrajectories, '2.0.0');
console.log(`  memory: ${memoryTrajectories.length} trajectories`);

const total = orchestratorTrajectories.length + contextEngineTrajectories.length + memoryTrajectories.length;
console.log(`\nDone. ${total} golden trajectories written to golden/data/`);

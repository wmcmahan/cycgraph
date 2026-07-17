/**
 * Context Engine Eval Suite
 *
 * Two-track evaluation for @cycgraph/context-engine:
 * - Deterministic track: compression ratio, information preservation,
 *   budget compliance, dedup correctness, format stability
 * - Semantic track: LLM-as-judge quality gate for compressed prompts
 *
 * @module suites/context-engine/suite
 */

import {
  createPipeline,
  createFormatStage,
  createExactDedupStage,
  createFuzzyDedupStage,
  createCotDistillationStage,
  createHeuristicPruningStage,
  createAllocatorStage,
  createHierarchyFormatterStage,
  createGraphSerializerStage,
  createOptimizedPipeline,
  createCircuitBreaker,
  createLatencyTracker,
  applyCachePolicy,
  serialize,
  dedup,
  distillCoT,
  fuzzyDedup,
  allocateBudget,
  formatHierarchy,
  serializeGraph,
  selectFormat,
  DefaultTokenCounter,
} from '@cycgraph/context-engine';
import type { PromptSegment, BudgetConfig, MemoryPayload } from '@cycgraph/context-engine';
import {
  assertGreaterThanOrEqual,
  assertLessThanOrEqual,
  assertContainsAllKeys,
  assertEqual,
  assertStable,
} from '../../assertions/deterministic.js';
import type { DeterministicResult } from '../../assertions/deterministic.js';
import type { TestCaseResults } from '../../assertions/drift-calculator.js';
import type { SutSuiteConfig } from '../sut-contract.js';
import { loadGoldenTrajectories } from '../../dataset/loader.js';
import { FAITHFULNESS } from '../../assertions/semantic-judge.js';
import { EFFICACY_SCENARIOS, joinSegments } from './efficacy-fixtures.js';

// ─── Test Fixtures ────────────────────────────────────────────────

const TABULAR_DATA = [
  { name: 'Alice', role: 'researcher', score: 92, status: 'active' },
  { name: 'Bob', role: 'writer', score: 87, status: 'active' },
  { name: 'Carol', role: 'reviewer', score: 95, status: 'inactive' },
  { name: 'Dave', role: 'editor', score: 78, status: 'active' },
  { name: 'Eve', role: 'researcher', score: 91, status: 'active' },
];

const NESTED_DATA = {
  workflow: { id: 'wf-001', status: 'running', started_at: '2026-04-05T10:00:00Z' },
  research_results: {
    topic: 'AI Cost Optimization',
    findings: [
      'Multi-agent systems cost 5-10x more than single-agent',
      'Task decomposition yields 70-90% cost reduction',
      'Context compression reduces tokens by 40-60%',
    ],
    confidence: 0.87,
  },
  agent_config: { model: 'claude-sonnet', temperature: 0.7, maxSteps: 10 },
};

const MEMORY_WITH_DUPLICATES = {
  agent_a: 'Multi-agent systems cost 5-10x more than single-agent.\n\nTask decomposition yields 70-90% cost reduction.\n\nContext compression reduces tokens by 40-60%.',
  agent_b: 'Multi-agent systems cost 5-10x more than single-agent.\n\nLocal deployment improves data sovereignty.\n\nContext compression reduces tokens by 40-60%.',
};

const counter = new DefaultTokenCounter();

// ─── Deterministic Track ──────────────────────────────────────────

/**
 * Runs deterministic assertions against context-engine APIs.
 * No LLM needed — fast, free, CI-friendly.
 */
export async function runDeterministic(): Promise<TestCaseResults[]> {
  const results: TestCaseResults[] = [];

  // Test 1: Tabular compression ratio >= 30%
  results.push(runCompressionRatioTest(
    'tabular_compression',
    TABULAR_DATA,
    30,
    'Tabular data (uniform arrays) should compress >= 30%',
  ));

  // Test 2: Nested compression ratio >= 10%
  results.push(runCompressionRatioTest(
    'nested_compression',
    NESTED_DATA,
    10,
    'Nested data should compress >= 10%',
  ));

  // Test 3: Information preservation — all original keys present
  results.push(runInformationPreservationTest());

  // Test 4: Budget compliance
  results.push(runBudgetComplianceTest());

  // Test 5: Cross-segment dedup
  results.push(runCrossSegmentDedupTest());

  // Test 6: Pipeline metrics consistency
  results.push(runPipelineMetricsTest());

  // Test 7: Format stability (idempotency)
  results.push(runFormatStabilityTest());

  // ── Phase 2 Tests ──

  // Test 8: CoT distillation removes reasoning traces
  results.push(runCotDistillationEval());

  // Test 9: Fuzzy dedup detects near-duplicates
  results.push(runFuzzyDedupEval());

  // Test 10: Cache policy locks system + tools segments
  results.push(runCachePolicyEval());

  // Test 11: Heuristic pruning preserves named entities
  results.push(runEntityPreservationEval());

  // Test 12: Full Phase 2 pipeline reduction
  results.push(runPhase2PipelineEval());

  // Test 13: Heuristic pruning reduces verbose prose
  results.push(runHeuristicReductionEval());

  // ── Phase 3 Tests ──

  // Test 14: Hierarchy formatter reduction vs JSON
  results.push(runHierarchyFormatterEval());

  // Test 15: Graph serializer reduction vs JSON
  results.push(runGraphSerializerEval());

  // Test 16: Model-aware format selection for small models
  results.push(runModelFormatSelectionEval());

  // ── Phase 4 Tests ──

  // Test 17: Circuit breaker bypasses inefficient stages
  results.push(runCircuitBreakerEval());

  // Test 18: Optimizer presets have correct stage counts
  results.push(runOptimizerPresetEval());

  // ── Efficacy Frontier Tests ──
  // Fidelity at compression ratio: for each scenario, gated presets must
  // hit the reduction floor AND preserve every planted critical fact and
  // negation. Thresholds are calibrated ratchets (current measured
  // behavior), not aspirations — see efficacy-fixtures.ts.
  results.push(...runEfficacyFrontierEvals());

  return results;
}

// ─── Efficacy Frontier (deterministic track) ───────────────────────

function runEfficacyFrontierEvals(): TestCaseResults[] {
  const results: TestCaseResults[] = [];

  for (const scenario of EFFICACY_SCENARIOS) {
    for (const preset of scenario.gatePresets) {
      const { pipeline } = createOptimizedPipeline({ preset });
      const result = pipeline.compress({
        segments: scenario.segments,
        budget: scenario.budget,
      });
      const compressed = joinSegments(result.segments);

      const survivingFacts = scenario.criticalFacts.filter(f => compressed.includes(f));
      const missingFacts = scenario.criticalFacts.filter(f => !compressed.includes(f));
      const survivingNegations = scenario.negations.filter(n => compressed.includes(n));

      const deterministicResults: DeterministicResult[] = [
        assertGreaterThanOrEqual(
          `efficacy_${scenario.name}_${preset}_reduction`,
          result.metrics.reductionPercent,
          scenario.minReductionPercent,
          `${preset} on ${scenario.name}: reduction >= ${scenario.minReductionPercent}% (${result.metrics.reductionPercent.toFixed(1)}% actual)`,
        ),
        assertEqual(
          `efficacy_${scenario.name}_${preset}_fact_survival`,
          survivingFacts.length,
          scenario.criticalFacts.length,
          `${preset} on ${scenario.name}: all ${scenario.criticalFacts.length} critical facts survive` +
            (missingFacts.length > 0 ? ` (missing: ${missingFacts.join(', ')})` : ''),
        ),
      ];

      if (scenario.negations.length > 0) {
        deterministicResults.push(
          assertEqual(
            `efficacy_${scenario.name}_${preset}_negation_survival`,
            survivingNegations.length,
            scenario.negations.length,
            `${preset} on ${scenario.name}: negations survive (meaning inversion guard)`,
          ),
        );
      }

      results.push({
        suite: 'context-engine',
        zodResults: [],
        semanticResults: [],
        deterministicResults,
      });
    }
  }

  return results;
}

function runCompressionRatioTest(
  testName: string,
  data: unknown,
  minReduction: number,
  description: string,
): TestCaseResults {
  const json = JSON.stringify(data, null, 2);
  const compressed = serialize(data);
  const before = counter.countTokens(json);
  const after = counter.countTokens(compressed);
  const reduction = ((before - after) / before) * 100;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        testName,
        reduction,
        minReduction,
        `${description} (${reduction.toFixed(1)}% actual)`,
      ),
    ],
  };
}

function runInformationPreservationTest(): TestCaseResults {
  const data = NESTED_DATA;
  const compressed = serialize(data);
  const keys = ['workflow', 'research_results', 'agent_config', 'topic', 'findings', 'model', 'temperature'];

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertContainsAllKeys(
        'information_preservation',
        compressed,
        keys,
        'All data keys should be present in compressed output',
      ),
    ],
  };
}

function runBudgetComplianceTest(): TestCaseResults {
  const segments: PromptSegment[] = [
    { id: 'system', content: 'You are a helpful assistant.', role: 'system', priority: 10, locked: true },
    { id: 'memory', content: 'x'.repeat(2000), role: 'memory', priority: 5, locked: false },
  ];
  const budget: BudgetConfig = { maxTokens: 200, outputReserve: 50 };
  const result = allocateBudget(segments, budget, counter);

  let totalAllocated = 0;
  for (const tokens of result.allocations.values()) {
    totalAllocated += tokens;
  }

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertLessThanOrEqual(
        'budget_compliance',
        totalAllocated,
        budget.maxTokens - (budget.outputReserve ?? 0),
        `Total allocation (${totalAllocated}) should not exceed available budget (${budget.maxTokens - (budget.outputReserve ?? 0)})`,
      ),
    ],
  };
}

function runCrossSegmentDedupTest(): TestCaseResults {
  const items = [
    'Multi-agent systems cost 5-10x more than single-agent.',
    'Task decomposition yields 70-90% cost reduction.',
    'Multi-agent systems cost 5-10x more than single-agent.',
  ];
  const result = dedup(items);

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('dedup_removed', result.removed, 1, 'Should remove exactly 1 duplicate'),
      assertEqual('dedup_unique', result.unique.length, 2, 'Should keep 2 unique items'),
    ],
  };
}

function runPipelineMetricsTest(): TestCaseResults {
  const pipeline = createPipeline({
    stages: [createFormatStage(), createExactDedupStage(), createAllocatorStage()],
  });
  const segments: PromptSegment[] = [{
    id: 'mem',
    content: JSON.stringify(NESTED_DATA, null, 2),
    role: 'memory',
    priority: 1,
    locked: false,
  }];
  const result = pipeline.compress({
    segments,
    budget: { maxTokens: 4096, outputReserve: 0 },
  });

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'metrics_consistency',
        result.metrics.totalTokensIn,
        result.metrics.totalTokensOut,
        `Tokens in (${result.metrics.totalTokensIn}) should be >= tokens out (${result.metrics.totalTokensOut})`,
      ),
      assertGreaterThanOrEqual(
        'metrics_stages_count',
        result.metrics.stages.length,
        3,
        'Pipeline should report metrics for all 3 stages',
      ),
    ],
  };
}

function runFormatStabilityTest(): TestCaseResults {
  const data = TABULAR_DATA;
  const run1 = serialize(data);
  const run2 = serialize(data);
  const run3 = serialize(data);

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertStable('format_stability', [run1, run2, run3], 'serialize() should produce identical output across runs'),
    ],
  };
}

// ─── Phase 2 Deterministic Helpers ─────────────────────────────────

function runCotDistillationEval(): TestCaseResults {
  const reasoning = '<think>Let me carefully consider all the options. First option A. Then option B. After careful analysis of all factors. Therefore: Option B is optimal.</think>';
  const content = `Analysis: ${reasoning} The recommendation is Option B.`;
  const result = distillCoT(content);

  const beforeTokens = counter.countTokens(content);
  const afterTokens = counter.countTokens(result.distilled);
  const reduction = ((beforeTokens - afterTokens) / beforeTokens) * 100;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'cot_distillation_reduction',
        reduction,
        30,
        `CoT distillation should remove >= 30% when reasoning present (${reduction.toFixed(1)}% actual)`,
      ),
    ],
  };
}

function runFuzzyDedupEval(): TestCaseResults {
  const items = [
    'Multi-agent systems cost 5-10x more than single-agent setups in production environments today',
    'Multi-agent systems cost 5-10x more than single-agent setups in production environments now',
  ];
  const result = fuzzyDedup(items, { threshold: 0.8 });

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('fuzzy_dedup_detection', result.removed, 1, 'Near-duplicates (1 word diff) should be detected at threshold 0.8'),
    ],
  };
}

function runCachePolicyEval(): TestCaseResults {
  const segments: PromptSegment[] = [
    { id: 'sys', content: 'System prompt', role: 'system', priority: 10, locked: false },
    { id: 'tools', content: 'Tool schemas', role: 'tools', priority: 8, locked: false },
    { id: 'mem', content: 'Memory data', role: 'memory', priority: 5, locked: false },
  ];
  const locked = applyCachePolicy(segments);

  const sysLocked = locked[0].locked ? 1 : 0;
  const toolsLocked = locked[1].locked ? 1 : 0;
  const memUnlocked = locked[2].locked ? 0 : 1;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('cache_prefix_sys', sysLocked, 1, 'System segment should be locked after applyCachePolicy'),
      assertEqual('cache_prefix_tools', toolsLocked, 1, 'Tools segment should be locked after applyCachePolicy'),
      assertEqual('cache_prefix_mem', memUnlocked, 1, 'Memory segment should remain unlocked'),
    ],
  };
}

function runEntityPreservationEval(): TestCaseResults {
  const pipeline = createPipeline({
    stages: [createHeuristicPruningStage()],
  });
  const content = 'Alice from Acme Corp reported that the very basic and essentially simple findings indicate a total cost of $42,000 for the deployment.';
  const segments: PromptSegment[] = [
    // Prose content: token-pruning applies to prose roles only (structured
    // 'memory'/'tools' segments are protected from corruption).
    { id: 'mem', content, role: 'history', priority: 1, locked: false },
  ];
  const result = pipeline.compress({
    segments,
    budget: { maxTokens: 15, outputReserve: 0 },
  });
  const output = result.segments[0].content;

  const hasAlice = output.includes('Alice') ? 1 : 0;
  const hasCost = output.includes('42,000') || output.includes('$42') ? 1 : 0;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('entity_preservation_name', hasAlice, 1, 'Named entity "Alice" should survive pruning'),
      assertEqual('entity_preservation_number', hasCost, 1, 'Dollar amount should survive pruning'),
    ],
  };
}

function runPhase2PipelineEval(): TestCaseResults {
  const reasoning = '<think>Long reasoning trace about costs and optimization strategies. We need to consider many factors. Therefore: Compression is essential.</think>';
  const verbose = 'It should be noted that in terms of the overall architecture, we essentially need to basically restructure the system.';
  const content = `${reasoning}\n\n${verbose}\n\nKey finding: compression saves 40-60% of tokens.`;

  const pipeline = createPipeline({
    stages: [
      createFormatStage(),
      createExactDedupStage(),
      createFuzzyDedupStage({ threshold: 0.8 }),
      createCotDistillationStage(),
      createHeuristicPruningStage(),
      createAllocatorStage(),
    ],
  });
  const segments: PromptSegment[] = [
    // Prose content: token-pruning applies to prose roles only (structured
    // 'memory'/'tools' segments are protected from corruption).
    { id: 'mem', content, role: 'history', priority: 1, locked: false },
  ];
  const result = pipeline.compress({
    segments,
    budget: { maxTokens: 80, outputReserve: 0 },
  });

  const before = counter.countTokens(content);
  const after = counter.countTokens(result.segments[0].content);
  const reduction = ((before - after) / before) * 100;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'phase2_pipeline_reduction',
        reduction,
        30,
        `Full Phase 2 pipeline should achieve >= 30% reduction (${reduction.toFixed(1)}% actual)`,
      ),
    ],
  };
}

function runHeuristicReductionEval(): TestCaseResults {
  const verbose = 'It should be noted that in order to improve the system we basically need to essentially restructure the very fundamental architecture of the entire application framework in terms of the overall design patterns and methodologies.';
  const pipeline = createPipeline({
    stages: [createHeuristicPruningStage()],
  });
  const segments: PromptSegment[] = [
    // Prose content: token-pruning applies to prose roles only.
    { id: 'mem', content: verbose, role: 'history', priority: 1, locked: false },
  ];
  const result = pipeline.compress({
    segments,
    budget: { maxTokens: 25, outputReserve: 0 },
  });

  const before = counter.countTokens(verbose);
  const after = counter.countTokens(result.segments[0].content);
  const reduction = ((before - after) / before) * 100;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'heuristic_pruning_reduction',
        reduction,
        15,
        `Heuristic pruning should reduce verbose prose >= 15% (${reduction.toFixed(1)}% actual)`,
      ),
    ],
  };
}

// ─── Phase 3 Deterministic Helpers ─────────────────────────────────

function runHierarchyFormatterEval(): TestCaseResults {
  const payload: MemoryPayload = {
    themes: [
      { id: 't1', label: 'Architecture', description: 'System design', fact_ids: ['f1', 'f2'] },
      { id: 't2', label: 'Team', description: 'People', fact_ids: ['f3'] },
    ],
    facts: [
      { id: 'f1', content: 'Uses graph-based workflow engine', source_episode_ids: [], entity_ids: [], theme_id: 't1', valid_from: new Date('2026-01-15') },
      { id: 'f2', content: 'API gateway uses rate limiting', source_episode_ids: [], entity_ids: [], theme_id: 't1', valid_from: new Date('2026-02-01') },
      { id: 'f3', content: 'Alice is lead engineer', source_episode_ids: [], entity_ids: [], theme_id: 't2', valid_from: new Date('2026-01-01') },
    ],
    episodes: [
      { id: 'e1', topic: 'Design review', messages: [{ role: 'user', content: 'What arch?', timestamp: new Date() }], started_at: new Date(), ended_at: new Date(), fact_ids: ['f1'] },
    ],
  };

  const json = JSON.stringify(payload, null, 2);
  const formatted = formatHierarchy(payload);

  const jsonTokens = counter.countTokens(json);
  const formattedTokens = counter.countTokens(formatted);
  const reduction = ((jsonTokens - formattedTokens) / jsonTokens) * 100;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'hierarchy_formatter_reduction',
        reduction,
        40,
        `Hierarchy format should use >= 40% fewer tokens than JSON (${reduction.toFixed(1)}% actual)`,
      ),
    ],
  };
}

function runGraphSerializerEval(): TestCaseResults {
  const entities = [
    { id: 'e1', name: 'Alice', entity_type: 'person', attributes: { role: 'engineer', dept: 'platform' } },
    { id: 'e2', name: 'Bob', entity_type: 'person', attributes: { role: 'manager', dept: 'infra' } },
    { id: 'e3', name: 'Platform', entity_type: 'project', attributes: { status: 'active' } },
  ];
  const relationships = [
    { id: 'r1', source_id: 'e1', target_id: 'e3', relation_type: 'works_on', weight: 1.0, attributes: {}, valid_from: new Date('2026-01-01') },
    { id: 'r2', source_id: 'e2', target_id: 'e1', relation_type: 'manages', weight: 0.8, attributes: {}, valid_from: new Date('2026-01-01') },
  ];

  const json = JSON.stringify({ entities, relationships }, null, 2);
  const formatted = serializeGraph(entities, relationships);

  const jsonTokens = counter.countTokens(json);
  const formattedTokens = counter.countTokens(formatted);
  const reduction = ((jsonTokens - formattedTokens) / jsonTokens) * 100;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'graph_serializer_reduction',
        reduction,
        30,
        `Graph format should use >= 30% fewer tokens than JSON (${reduction.toFixed(1)}% actual)`,
      ),
    ],
  };
}

function runModelFormatSelectionEval(): TestCaseResults {
  const gemmaSelection = selectFormat('gemma-2-9b');
  const claudeSelection = selectFormat('claude-sonnet-4-6');

  const gemmaUsesJson = gemmaSelection.useCompactJson ? 1 : 0;
  const claudeUsesCustom = claudeSelection.useCompactJson ? 0 : 1;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('model_format_gemma_json', gemmaUsesJson, 1, 'Gemma should use compact JSON (small model)'),
      assertEqual('model_format_claude_custom', claudeUsesCustom, 1, 'Claude should use custom format (capable model)'),
    ],
  };
}

// ─── Phase 4 Deterministic Helpers ─────────────────────────────────

function runCircuitBreakerEval(): TestCaseResults {
  const tracker = createLatencyTracker();
  // Noop stage (saves 0 tokens) — should be bypassed after warmup
  const noop = {
    name: 'noop-ml' as const,
    execute(segments: PromptSegment[]) { return { segments }; },
  };
  const breaker = createCircuitBreaker(noop, tracker, {
    warmupSamples: 2,
    minEfficiency: 1.0,
    cooldownMs: 60_000,
  });

  const segments: PromptSegment[] = [
    { id: 'a', content: 'test content', role: 'memory', priority: 1, locked: false },
  ];
  const ctx = {
    tokenCounter: counter,
    budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
  };

  // Warmup (2 samples)
  breaker.execute(segments, ctx);
  breaker.execute(segments, ctx);
  // After warmup: efficiency = 0 → bypass immediately
  breaker.execute(segments, ctx);
  breaker.execute(segments, ctx);

  // Should still be at 2 samples (bypassed immediately, no new samples)
  const samples = tracker.getAverage('noop-ml').samplesCount;

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual(
        'circuit_breaker_bypass',
        samples,
        2, // 2 warmup, then bypassed immediately (no cooldown retry yet)
        'Circuit breaker should bypass immediately after warmup when efficiency is low',
      ),
    ],
  };
}

function runOptimizerPresetEval(): TestCaseResults {
  const fast = createOptimizedPipeline({ preset: 'fast' });
  const balanced = createOptimizedPipeline({ preset: 'balanced' });
  const maximum = createOptimizedPipeline({ preset: 'maximum' });

  return {
    suite: 'context-engine',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('optimizer_fast_stages', fast.stageNames.length, 3, 'Fast preset should have 3 stages'),
      assertEqual('optimizer_balanced_stages', balanced.stageNames.length, 6, 'Balanced preset should have 6 stages'),
      assertGreaterThanOrEqual('optimizer_maximum_stages', maximum.stageNames.length, 8, 'Maximum preset should have >= 8 stages'),
    ],
  };
}

// ─── SUT-Driven Semantic Track ────────────────────────────────────

/**
 * Build the SUT-driven semantic suite for context-engine.
 *
 * One test per golden trajectory. The library is deterministic — running
 * each trajectory's input through `runContextEngineSut` produces a JSON
 * `actualOutput` we can compare against the recorded `expectedOutput`
 * via the `FAITHFULNESS` metric.
 *
 * Context-engine trajectories have no tool calls, so structural
 * assertions are disabled.
 */
export async function buildSutSuite(): Promise<SutSuiteConfig> {
  const trajectories = loadGoldenTrajectories('context-engine');
  return {
    name: 'context-engine',
    tests: trajectories.map(t => ({
      trajectoryId: t.id,
      description: t.description,
      metrics: [{ metric: FAITHFULNESS }],
      structuralAssertions: false,
    })),
  };
}

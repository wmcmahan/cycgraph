/**
 * Node-type authoring helpers: each must compile to the same wire node the
 * hand-authored `node()` form produces, or the helper is a second dialect
 * rather than sugar over the first.
 */

import { describe, it, expect } from 'vitest';
import { agent, node, graph, supervisor, mapReduce, verifier, runTool, voting, evolution, reflection, approval, router, synthesizer, a2a, subgraph } from '../src/authoring/index.js';
import type { Graph } from '../src/graph/graph.js';
import { validateGraph } from '../src/graph/graph-validator.js';

const brain = agent({ name: 'Router', model: 'claude-sonnet-4-20250514', provider: 'anthropic', systemPrompt: 'Route.' });
const worker = node({ id: 'worker', agent: brain, reads: ['item'], writes: ['item_out'] });
const combine = node({ id: 'combine', type: 'synthesizer', reads: ['fanout_results'] });

/** The compiled node with generated ids stripped, so two graphs compare cleanly. */
function wireNode(g: Graph, id: string) {
  const n = g.nodes.find((x) => x.id === id);
  return n ? { ...n, agent_id: n.agent_id ? '<agent>' : undefined } : undefined;
}

describe('supervisor', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    const viaHelper = graph({
      name: 'h',
      nodes: [worker, supervisor(brain, { id: 'sup', manages: [worker], maxIterations: 7 })],
      startNode: 'sup',
    });
    const viaNode = graph({
      name: 'h',
      nodes: [worker, node({
        id: 'sup',
        type: 'supervisor',
        agent: brain,
        supervisorConfig: { managedNodes: [worker], maxIterations: 7 },
      })],
      startNode: 'sup',
    });

    expect(wireNode(viaHelper, 'sup')).toEqual(wireNode(viaNode, 'sup'));
  });

  it('resolves managed node values to their ids', () => {
    const g = graph({ name: 'h', nodes: [worker, supervisor(brain, { id: 'sup', manages: [worker] })], startNode: 'sup' });

    expect(g.nodes.find((n) => n.id === 'sup')?.supervisor_config?.managed_nodes).toEqual(['worker']);
  });

  it('omits max_iterations so the schema default applies', () => {
    const g = graph({ name: 'h', nodes: [worker, supervisor(brain, { id: 'sup', manages: [worker] })], startNode: 'sup' });

    expect(g.nodes.find((n) => n.id === 'sup')?.supervisor_config?.max_iterations).toBe(10);
  });

  it('leaves read_keys empty so the engine derives them from managed nodes', () => {
    const g = graph({ name: 'h', nodes: [worker, supervisor(brain, { id: 'sup', manages: [worker] })], startNode: 'sup' });

    expect(g.nodes.find((n) => n.id === 'sup')?.read_keys).toEqual([]);
  });
});

describe('mapReduce', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    const viaHelper = graph({
      name: 'm',
      nodes: [worker, combine, mapReduce(worker, { id: 'fanout', items: '$.topics', into: combine, concurrency: 3 })],
      startNode: 'fanout',
    });
    const viaNode = graph({
      name: 'm',
      nodes: [worker, combine, node({
        id: 'fanout',
        type: 'map',
        mapReduceConfig: { workerNodeId: worker, itemsPath: '$.topics', synthesizerNodeId: combine, maxConcurrency: 3 },
      })],
      startNode: 'fanout',
    });

    expect(wireNode(viaHelper, 'fanout')).toEqual(wireNode(viaNode, 'fanout'));
  });

  it('routes a string items value to items_path', () => {
    const g = graph({ name: 'm', nodes: [worker, mapReduce(worker, { id: 'fanout', items: '$.topics' })], startNode: 'fanout' });
    const cfg = g.nodes.find((n) => n.id === 'fanout')?.map_reduce_config;

    expect(cfg?.items_path).toBe('$.topics');
    expect(cfg?.static_items).toBeUndefined();
  });

  it('routes an array items value to static_items', () => {
    const g = graph({ name: 'm', nodes: [worker, mapReduce(worker, { id: 'fanout', items: ['a', 'b'] })], startNode: 'fanout' });
    const cfg = g.nodes.find((n) => n.id === 'fanout')?.map_reduce_config;

    expect(cfg?.static_items).toEqual(['a', 'b']);
    expect(cfg?.items_path).toBeUndefined();
  });

  it('resolves worker and synthesizer node values to their ids', () => {
    const g = graph({
      name: 'm',
      nodes: [worker, combine, mapReduce(worker, { id: 'fanout', items: '$.t', into: combine })],
      startNode: 'fanout',
    });
    const cfg = g.nodes.find((n) => n.id === 'fanout')?.map_reduce_config;

    expect(cfg?.worker_node_id).toBe('worker');
    expect(cfg?.synthesizer_node_id).toBe('combine');
  });

  it('declares no write_keys, leaving the engine to imply the result keys', () => {
    const g = graph({ name: 'm', nodes: [worker, mapReduce(worker, { id: 'fanout', items: '$.t' })], startNode: 'fanout' });

    expect(g.nodes.find((n) => n.id === 'fanout')?.write_keys).toEqual([]);
  });
});

describe('verifier', () => {
  const judge = agent({ name: 'Judge', model: 'claude-sonnet-4-20250514', provider: 'anthropic', systemPrompt: 'Judge.' });

  it('llmJudge compiles to the same wire node as the hand-authored form', () => {
    const viaHelper = graph({
      name: 'v',
      nodes: [verifier.llmJudge(judge, { id: 'check', target: 'draft', threshold: 0.7, reads: ['draft'] })],
      startNode: 'check',
    });
    const viaNode = graph({
      name: 'v',
      nodes: [node({
        id: 'check',
        type: 'verifier',
        reads: ['draft'],
        verifierConfig: { type: 'llm_judge', targetKey: 'draft', evaluatorAgentId: judge, passThreshold: 0.7 },
      })],
      startNode: 'check',
    });

    expect(wireNode(viaHelper, 'check')).toEqual(wireNode(viaNode, 'check'));
  });

  it('expression compiles to the same wire node as the hand-authored form', () => {
    const viaHelper = graph({
      name: 'v',
      nodes: [verifier.expression('length(memory.draft) > 100', { id: 'check', reads: ['draft'] })],
      startNode: 'check',
    });
    const viaNode = graph({
      name: 'v',
      nodes: [node({
        id: 'check',
        type: 'verifier',
        reads: ['draft'],
        verifierConfig: { type: 'expression', expression: 'length(memory.draft) > 100' },
      })],
      startNode: 'check',
    });

    expect(wireNode(viaHelper, 'check')).toEqual(wireNode(viaNode, 'check'));
  });

  it('jsonPath compiles to the same wire node as the hand-authored form', () => {
    const viaHelper = graph({
      name: 'v',
      nodes: [verifier.jsonPath('order', { id: 'check', path: '$.email', assertion: { op: 'exists' }, reads: ['order'] })],
      startNode: 'check',
    });
    const viaNode = graph({
      name: 'v',
      nodes: [node({
        id: 'check',
        type: 'verifier',
        reads: ['order'],
        verifierConfig: { type: 'jsonpath', targetKey: 'order', path: '$.email', assertion: { op: 'exists' } },
      })],
      startNode: 'check',
    });

    expect(wireNode(viaHelper, 'check')).toEqual(wireNode(viaNode, 'check'));
  });

  it('all three variants land on the same node type', () => {
    const g = graph({
      name: 'v',
      nodes: [
        verifier.expression('true', { id: 'a' }),
        verifier.jsonPath('order', { id: 'b', path: '$.x', assertion: { op: 'exists' } }),
        verifier.llmJudge(judge, { id: 'c', target: 'draft' }),
      ],
      startNode: 'a',
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    });

    expect(g.nodes.map((n) => n.type)).toEqual(['verifier', 'verifier', 'verifier']);
  });

  it('carries throwOnFail and resultKey onto the config, not the node', () => {
    const g = graph({
      name: 'v',
      nodes: [verifier.expression('true', { id: 'check', throwOnFail: true, resultKey: 'gate' })],
      startNode: 'check',
    });
    const n = g.nodes[0];

    expect(n.verifier_config?.throw_on_fail).toBe(true);
    expect(n.verifier_config?.result_key).toBe('gate');
  });

  it('declares no write_keys, leaving the engine to imply both result keys', () => {
    const g = graph({ name: 'v', nodes: [verifier.expression('true', { id: 'check' })], startNode: 'check' });

    expect(g.nodes[0].write_keys).toEqual([]);
  });
});

const cand = agent({ name: 'Cand', model: 'claude-sonnet-4-20250514', provider: 'anthropic', systemPrompt: 'Draft.' });

/** Compile a one-node graph and return that node's wire form. */
function only(n: ReturnType<typeof node>) {
  return wireNode(graph({ name: 'x', nodes: [n], startNode: n.id }), n.id);
}

describe('runTool', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    expect(only(runTool('fetch_data', { id: 'fetch', reads: ['url'] })))
      .toEqual(only(node({ id: 'fetch', type: 'tool', toolId: 'fetch_data', reads: ['url'] })));
  });

  it('passes the reads slice through as the tool argument list', () => {
    expect(only(runTool('fetch_data', { id: 'fetch', reads: ['url', 'method'] }))?.read_keys)
      .toEqual(['url', 'method']);
  });
});

describe('voting', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    expect(only(voting([cand, 'other'], { id: 'vote', strategy: 'majority_vote', quorum: 2 })))
      .toEqual(only(node({ id: 'vote', type: 'voting',
        votingConfig: { voterAgentIds: [cand, 'other'], strategy: 'majority_vote', quorum: 2 } })));
  });

  it('maps judge onto judge_agent_id', () => {
    expect(only(voting(['a', 'b'], { id: 'vote', strategy: 'llm_judge', judge: 'j' }))?.voting_config?.judge_agent_id)
      .toBe('j');
  });
});

describe('evolution', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    expect(only(evolution(cand, { id: 'evo', evaluator: 'critic', populationSize: 4, maxGenerations: 3 })))
      .toEqual(only(node({ id: 'evo', type: 'evolution',
        evolutionConfig: { candidateAgentId: cand, evaluatorAgentId: 'critic', populationSize: 4, maxGenerations: 3 } })));
  });

  it('maps selection onto selection_strategy', () => {
    expect(only(evolution('c', { id: 'evo', evaluator: 'e', selection: 'tournament' }))?.evolution_config?.selection_strategy)
      .toBe('tournament');
  });
});

describe('reflection', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    const extractor = { type: 'rule_based' as const, minSentenceLength: 25 };
    expect(only(reflection(['notes'], { id: 'reflect', reads: ['notes'], extractor, tags: ['lesson'] })))
      .toEqual(only(node({ id: 'reflect', type: 'reflection', reads: ['notes'],
        reflectionConfig: { sourceKeys: ['notes'], extractor, tags: ['lesson'] } })));
  });

  it('puts the leading argument on source_keys', () => {
    const n = only(reflection(['a', 'b'], { id: 'r', extractor: { type: 'rule_based' } }));
    expect(n?.reflection_config?.source_keys).toEqual(['a', 'b']);
  });
});

describe('approval', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    expect(only(approval({ id: 'gate', prompt: 'Review', reviewKeys: ['draft'] })))
      .toEqual(only(node({ id: 'gate', type: 'approval',
        approvalConfig: { promptMessage: 'Review', reviewKeys: ['draft'] } })));
  });

  it('maps onReject onto rejection_node_id', () => {
    expect(only(approval({ id: 'gate', onReject: 'revise' }))?.approval_config?.rejection_node_id).toBe('revise');
  });
});

describe('router', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    expect(only(router({ id: 'branch', reads: ['decision'] })))
      .toEqual(only(node({ id: 'branch', type: 'router', reads: ['decision'] })));
  });

  it('carries no config block', () => {
    const n = only(router({ id: 'branch' }));
    expect(n?.supervisor_config).toBeUndefined();
    expect(n?.type).toBe('router');
  });
});

describe('synthesizer', () => {
  it('compiles to the same wire node as the hand-authored form', () => {
    expect(only(synthesizer({ id: 'combine', reads: ['fanout_results'] })))
      .toEqual(only(node({ id: 'combine', type: 'synthesizer', reads: ['fanout_results'] })));
  });

  it('accepts an optional agent for a written synthesis', () => {
    expect(only(synthesizer({ id: 'combine', agent: cand, reads: ['r'] }))?.agent_id).toBe('<agent>');
  });

  it('omits agent_id for a deterministic merge', () => {
    expect(only(synthesizer({ id: 'combine', reads: ['r'] }))?.agent_id).toBeUndefined();
  });

  it('grants an agent-backed synthesizer the write keys it declares', () => {
    const n = only(synthesizer({ id: 'combine', agent: cand, reads: ['r'], writes: ['summary'] }));

    expect(n?.write_keys).toEqual(['summary']);
  });

  it('leaves an agentless synthesizer to the implied synthesis key', () => {
    const n = only(synthesizer({ id: 'combine', reads: ['r'] }));

    expect(n?.write_keys).toEqual([]);
  });
});

describe('NodeCommon', () => {
  it('carries failure policy through a helper onto the wire node', () => {
    const n = only(runTool('t', { id: 'x', failurePolicy: { maxRetries: 5 } }));

    expect(n?.failure_policy?.max_retries).toBe(5);
  });

  it('carries a per-node budget through a helper onto the wire node', () => {
    const n = only(mapReduce('w', { id: 'm', items: '$.t', budget: { maxCostUsd: 0.5 } }));

    expect(n?.budget?.max_cost_usd).toBe(0.5);
  });

  it('does not offer a budget on a2a, whose remote spend is unmeterable', () => {
    const n = only(a2a('srv', { id: 'r', failurePolicy: { maxRetries: 2 } }));

    expect(n?.budget).toBeUndefined();
    expect(n?.failure_policy?.max_retries).toBe(2);
  });
});

describe('converted example shapes', () => {
  const writer = agent({ name: 'W', model: 'claude-sonnet-4-20250514', provider: 'anthropic', systemPrompt: 'Write.' });

  it('an approval gate validates without declaring control_flow', () => {
    const draft = node({ id: 'draft', agent: writer, reads: ['goal'], writes: 'draft' });
    const review = approval({ id: 'review', prompt: 'Review', reviewKeys: ['draft'], reads: ['*'], writes: ['*'] });
    const g = graph({ name: 'hitl', nodes: [draft, review], edges: [{ from: draft, to: review }] });

    expect(validateGraph(g).errors).toEqual([]);
  });

  it('a voting node validates with no declared writes', () => {
    const vote = voting([writer, 'b', 'c'], { id: 'vote', strategy: 'majority_vote', quorum: 2, reads: ['*'] });
    const g = graph({ name: 'v', nodes: [vote], startNode: 'vote' });

    expect(validateGraph(g).errors).toEqual([]);
  });

  it('a reflection node validates with only its pinned result key implied', () => {
    const notes = node({ id: 'research', agent: writer, reads: ['goal'], writes: 'research_notes' });
    const reflect = reflection(['research_notes'], {
      id: 'reflect',
      reads: ['research_notes'],
      extractor: { type: 'rule_based', minSentenceLength: 25 },
      tags: ['lesson'],
      resultKey: 'research_notes_reflection',
    });
    const g = graph({ name: 'r', nodes: [notes, reflect], edges: [{ from: notes, to: reflect }] });

    expect(validateGraph(g).errors).toEqual([]);
  });

  it('a verifier feeding a fix loop validates, and downstream may read its implied result', () => {
    const extract = node({ id: 'extract', agent: writer, reads: ['goal'], writes: 'purchase_order' });
    const check = verifier.jsonPath('purchase_order', {
      id: 'verify_email',
      path: '$.customer_email',
      assertion: { op: 'exists' },
      reads: ['purchase_order'],
    });
    const fix = node({
      id: 'fix', agent: writer,
      reads: ['purchase_order', 'verify_email_verification'],
      writes: 'purchase_order',
    });
    const g = graph({
      name: 'fix-loop',
      nodes: [extract, check, fix],
      edges: [{ from: extract, to: check }, { from: check, to: fix }],
      startNode: 'extract', endNodes: ['verify_email'],
    });

    expect(validateGraph(g).errors).toEqual([]);
  });

  it('a runTool chain validates with reads serving as the argument slice', () => {
    const fetchData = runTool('mock_fetch', { id: 'fetch', reads: ['*'] });
    const transform = runTool('mock_transform', { id: 'transform', reads: ['*'] });
    const g = graph({ name: 'lin', nodes: [fetchData, transform], edges: [{ from: fetchData, to: transform }] });

    expect(validateGraph(g).errors).toEqual([]);
  });
});

describe('shipped helpers accept the common node fields', () => {
  const child = graph({ name: 'child', nodes: [node({ id: 'c', type: 'router' })], startNode: 'c' });

  it('subgraph carries a failure policy onto the wire node', () => {
    const n = only(subgraph(child, { id: 's', failurePolicy: { maxRetries: 4 } }));

    expect(n?.failure_policy?.max_retries).toBe(4);
  });

  it('subgraph carries a per-node budget, whose child spend the engine meters', () => {
    const n = only(subgraph(child, { id: 's', budget: { maxCostUsd: 1.5 } }));

    expect(n?.budget?.max_cost_usd).toBe(1.5);
  });

  it('a2a carries a failure policy, the bound that does apply to a remote task', () => {
    const n = only(a2a('srv', { id: 'r', failurePolicy: { maxRetries: 3, backoffStrategy: 'fixed' } }));

    expect(n?.failure_policy?.max_retries).toBe(3);
    expect(n?.failure_policy?.backoff_strategy).toBe('fixed');
  });

  it('both carry metadata and compensation flags', () => {
    const n = only(subgraph(child, { id: 's', metadata: { owner: 'platform' }, requiresCompensation: true }));

    expect(n?.metadata).toEqual({ owner: 'platform' });
    expect(n?.requires_compensation).toBe(true);
  });
});

describe('optional spec fields reach the wire config', () => {
  const a = agent({ name: 'A', model: 'claude-sonnet-4-20250514', provider: 'anthropic', systemPrompt: 'x' });

  it('evolution carries every tuning field', () => {
    const cfg = only(evolution(a, {
      id: 'evo', evaluator: 'critic', populationSize: 6, maxGenerations: 9,
      fitnessThreshold: 0.91, stagnationGenerations: 4, selection: 'tournament',
      eliteCount: 2, concurrency: 3, criteria: 'be terse', onError: 'fail_fast',
      initialTemperature: 1.2, finalTemperature: 0.4, tournamentSize: 5, taskTimeoutMs: 9_000,
    }))?.evolution_config;

    expect(cfg).toMatchObject({
      evaluator_agent_id: 'critic', population_size: 6, max_generations: 9,
      fitness_threshold: 0.91, stagnation_generations: 4, selection_strategy: 'tournament',
      elite_count: 2, max_concurrency: 3, evaluation_criteria: 'be terse',
      error_strategy: 'fail_fast', initial_temperature: 1.2, final_temperature: 0.4,
      tournament_size: 5, task_timeout_ms: 9_000,
    });
  });

  it('evolution omits every optional field, leaving schema defaults', () => {
    const cfg = only(evolution(a, { id: 'evo' }))?.evolution_config;

    expect(cfg?.evaluator_agent_id).toBeUndefined();
    expect(cfg?.evaluation_criteria).toBeUndefined();
    expect(cfg?.population_size).toBe(5);
  });

  it('voting carries every optional field', () => {
    const cfg = only(voting(['a', 'b'], {
      id: 'v', strategy: 'weighted_vote', voteKey: 'verdict', quorum: 2,
      judge: 'j', weights: { a: 2 }, taskTimeoutMs: 4_000,
    }))?.voting_config;

    expect(cfg).toMatchObject({
      strategy: 'weighted_vote', vote_key: 'verdict', quorum: 2,
      judge_agent_id: 'j', weights: { a: 2 }, task_timeout_ms: 4_000,
    });
  });

  it('voting omits every optional field', () => {
    const cfg = only(voting(['a', 'b'], { id: 'v' }))?.voting_config;

    expect(cfg?.judge_agent_id).toBeUndefined();
    expect(cfg?.weights).toBeUndefined();
    expect(cfg?.quorum).toBeUndefined();
  });

  it('mapReduce carries every optional field', () => {
    const cfg = only(mapReduce('w', {
      id: 'm', items: '$.t', into: 'combine', concurrency: 7,
      maxItems: 40, onError: 'fail_fast', taskTimeoutMs: 5_000,
    }))?.map_reduce_config;

    expect(cfg).toMatchObject({
      synthesizer_node_id: 'combine', max_concurrency: 7, max_items: 40,
      error_strategy: 'fail_fast', task_timeout_ms: 5_000,
    });
  });

  it('mapReduce omits every optional field', () => {
    const cfg = only(mapReduce('w', { id: 'm', items: '$.t' }))?.map_reduce_config;

    expect(cfg?.synthesizer_node_id).toBeUndefined();
    expect(cfg?.task_timeout_ms).toBeUndefined();
  });

  it('reflection carries every optional field', () => {
    const cfg = only(reflection(['a'], {
      id: 'r', extractor: { type: 'rule_based' },
      tags: ['lesson'], entityKeys: ['topic'], resultKey: 'pinned',
    }))?.reflection_config;

    expect(cfg).toMatchObject({ tags: ['lesson'], entity_keys: ['topic'], result_key: 'pinned' });
  });

  it('reflection omits every optional field', () => {
    const cfg = only(reflection(['a'], { id: 'r', extractor: { type: 'rule_based' } }))?.reflection_config;

    expect(cfg?.entity_keys).toBeUndefined();
    expect(cfg?.result_key).toBeUndefined();
  });

  it('approval carries every optional field', () => {
    const cfg = only(approval({
      id: 'g', prompt: 'Review', reviewKeys: ['draft'], timeoutMs: 1_000, onReject: 'revise',
    }))?.approval_config;

    expect(cfg).toMatchObject({
      prompt_message: 'Review', review_keys: ['draft'], timeout_ms: 1_000, rejection_node_id: 'revise',
    });
  });

  it('approval omits every optional field, leaving schema defaults', () => {
    const cfg = only(approval({ id: 'g' }))?.approval_config;

    expect(cfg?.rejection_node_id).toBeUndefined();
    expect(cfg?.timeout_ms).toBe(86_400_000);
  });

  it('verifier variants carry every optional field', () => {
    const judged = only(verifier.llmJudge(a, {
      id: 'c', target: 'draft', threshold: 0.6, criteria: 'strict',
      resultKey: 'gate', throwOnFail: true, description: 'checks the draft',
    }))?.verifier_config;

    expect(judged).toMatchObject({
      pass_threshold: 0.6, evaluation_criteria: 'strict',
      result_key: 'gate', throw_on_fail: true, description: 'checks the draft',
    });
  });

  it('verifier variants omit every optional field', () => {
    const cfg = only(verifier.llmJudge(a, { id: 'c', target: 'draft' }))?.verifier_config;

    expect(cfg?.evaluation_criteria).toBeUndefined();
    expect(cfg?.result_key).toBeUndefined();
    expect(cfg?.description).toBeUndefined();
  });

  it('supervisor omits maxIterations, leaving the schema default', () => {
    const cfg = only(supervisor(a, { id: 's', manages: ['x'] }))?.supervisor_config;

    expect(cfg?.max_iterations).toBe(10);
  });

  it('a2a carries every optional field', () => {
    const cfg = only(a2a('srv', {
      id: 'r', skill: 'research', inputs: { t: 'q' }, outputs: { rep: 'n' }, maxWaitMs: 30_000,
    }))?.a2a_config;

    expect(cfg).toMatchObject({
      skill_id: 'research', input_mapping: { t: 'q' },
      output_mapping: { rep: 'n' }, max_wait_ms: 30_000,
    });
  });

  it('a2a omits every optional field', () => {
    const cfg = only(a2a('srv', { id: 'r' }))?.a2a_config;

    expect(cfg?.skill_id).toBeUndefined();
    expect(cfg?.max_wait_ms).toBeUndefined();
  });
});

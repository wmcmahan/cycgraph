/**
 * verifier.test.ts — the verifier node executor (llm_judge / expression / jsonpath)
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { executeVerifierNode } from '../src/runner/node-executors/verifier.js';
import { VerificationFailedError } from '../src/runner/node-executors/errors.js';
import { NodeConfigError } from '../src/runner/errors.js';
import type { GraphNode, VerifierConfig } from '../src/types/graph.js';
import type { StateView } from '../src/types/state.js';
import type { NodeExecutorContext } from '../src/runner/node-executors/context.js';

function makeStateView(memory: Record<string, unknown>, goal = 'verify the work'): StateView {
  return {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    goal,
    constraints: [],
    memory,
  };
}

function makeNode(config: VerifierConfig | undefined): GraphNode {
  return {
    id: 'verify',
    type: 'verifier',
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 0, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
    requires_compensation: false,
    ...(config ? { verifier_config: config } : {}),
  } as GraphNode;
}

function makeCtx(evaluate?: ReturnType<typeof vi.fn>): NodeExecutorContext {
  return {
    state: { iteration_count: 0 },
    deps: {
      evaluateQualityExecutor: evaluate ?? vi.fn(),
    },
  } as unknown as NodeExecutorContext;
}

describe('executeVerifierNode', () => {
  it('throws NodeConfigError when verifier_config is missing', async () => {
    await expect(
      executeVerifierNode(makeNode(undefined), makeStateView({}), 1, makeCtx()),
    ).rejects.toBeInstanceOf(NodeConfigError);
  });

  describe('expression variant', () => {
    it('passes when the filtrex expression is truthy', async () => {
      const node = makeNode({ type: 'expression', expression: 'memory.score > 5' });
      const action = await executeVerifierNode(node, makeStateView({ score: 9 }), 1, makeCtx());
      expect(action.payload.updates.verify_verification_passed).toBe(true);
      const result = action.payload.updates.verify_verification as { type: string; passed: boolean };
      expect(result.type).toBe('expression');
      expect(result.passed).toBe(true);
    });

    it('fails when the expression is falsy', async () => {
      const node = makeNode({ type: 'expression', expression: 'memory.score > 5' });
      const action = await executeVerifierNode(node, makeStateView({ score: 2 }), 1, makeCtx());
      expect(action.payload.updates.verify_verification_passed).toBe(false);
    });

    it('honors a custom result_key', async () => {
      const node = makeNode({ type: 'expression', expression: 'memory.count >= 1', result_key: 'gate' });
      const action = await executeVerifierNode(node, makeStateView({ count: 3 }), 1, makeCtx());
      expect(action.payload.updates.gate_passed).toBe(true);
      expect(action.payload.updates.gate).toBeDefined();
    });
  });

  describe('jsonpath variant', () => {
    it('exists assertion', async () => {
      const node = makeNode({
        type: 'jsonpath',
        target_key: 'invoice',
        path: '$.total',
        assertion: { op: 'exists' },
      });
      const pass = await executeVerifierNode(node, makeStateView({ invoice: { total: 42 } }), 1, makeCtx());
      expect(pass.payload.updates.verify_verification_passed).toBe(true);

      const fail = await executeVerifierNode(node, makeStateView({ invoice: {} }), 1, makeCtx());
      expect(fail.payload.updates.verify_verification_passed).toBe(false);
    });

    it('gte numeric assertion + extracted_value in result', async () => {
      const node = makeNode({
        type: 'jsonpath',
        target_key: 'invoice',
        path: '$.total',
        assertion: { op: 'gte', value: 100 },
      });
      const action = await executeVerifierNode(node, makeStateView({ invoice: { total: 150 } }), 1, makeCtx());
      expect(action.payload.updates.verify_verification_passed).toBe(true);
      const result = action.payload.updates.verify_verification as { extracted_value: unknown };
      expect(result.extracted_value).toBe(150);
    });

    it('matches regex assertion', async () => {
      const node = makeNode({
        type: 'jsonpath',
        target_key: 'doc',
        path: '$.id',
        assertion: { op: 'matches', pattern: '^INV-\\d+$' },
      });
      const ok = await executeVerifierNode(node, makeStateView({ doc: { id: 'INV-123' } }), 1, makeCtx());
      expect(ok.payload.updates.verify_verification_passed).toBe(true);
      const bad = await executeVerifierNode(node, makeStateView({ doc: { id: 'nope' } }), 1, makeCtx());
      expect(bad.payload.updates.verify_verification_passed).toBe(false);
    });

    it('equals assertion passes on strict equality and fails otherwise', async () => {
      const node = makeNode({ type: 'jsonpath', target_key: 'doc', path: '$.status', assertion: { op: 'equals', value: 'ok' } });

      const ok = await executeVerifierNode(node, makeStateView({ doc: { status: 'ok' } }), 1, makeCtx());
      const bad = await executeVerifierNode(node, makeStateView({ doc: { status: 'nope' } }), 1, makeCtx());

      expect(ok.payload.updates.verify_verification_passed).toBe(true);
      expect(bad.payload.updates.verify_verification_passed).toBe(false);
    });

    it('gt assertion passes only when strictly greater', async () => {
      const node = makeNode({ type: 'jsonpath', target_key: 'm', path: '$.n', assertion: { op: 'gt', value: 10 } });

      const over = await executeVerifierNode(node, makeStateView({ m: { n: 11 } }), 1, makeCtx());
      const equal = await executeVerifierNode(node, makeStateView({ m: { n: 10 } }), 1, makeCtx());

      expect(over.payload.updates.verify_verification_passed).toBe(true);
      expect(equal.payload.updates.verify_verification_passed).toBe(false);
    });

    it('lt assertion passes only when strictly less', async () => {
      const node = makeNode({ type: 'jsonpath', target_key: 'm', path: '$.n', assertion: { op: 'lt', value: 10 } });

      const under = await executeVerifierNode(node, makeStateView({ m: { n: 9 } }), 1, makeCtx());
      const equal = await executeVerifierNode(node, makeStateView({ m: { n: 10 } }), 1, makeCtx());

      expect(under.payload.updates.verify_verification_passed).toBe(true);
      expect(equal.payload.updates.verify_verification_passed).toBe(false);
    });

    it('lte assertion passes at or below the bound', async () => {
      const node = makeNode({ type: 'jsonpath', target_key: 'm', path: '$.n', assertion: { op: 'lte', value: 10 } });

      const equal = await executeVerifierNode(node, makeStateView({ m: { n: 10 } }), 1, makeCtx());
      const over = await executeVerifierNode(node, makeStateView({ m: { n: 11 } }), 1, makeCtx());

      expect(equal.payload.updates.verify_verification_passed).toBe(true);
      expect(over.payload.updates.verify_verification_passed).toBe(false);
    });

    it('fails a numeric assertion when the extracted value is not a number', async () => {
      const node = makeNode({ type: 'jsonpath', target_key: 'm', path: '$.n', assertion: { op: 'gte', value: 5 } });

      const action = await executeVerifierNode(node, makeStateView({ m: { n: 'not-a-number' } }), 1, makeCtx());

      expect(action.payload.updates.verify_verification_passed).toBe(false);
    });

    it('fails closed when the regex pattern is syntactically invalid', async () => {
      const node = makeNode({ type: 'jsonpath', target_key: 'doc', path: '$.id', assertion: { op: 'matches', pattern: '[' } });

      const action = await executeVerifierNode(node, makeStateView({ doc: { id: 'anything' } }), 1, makeCtx());

      expect(action.payload.updates.verify_verification_passed).toBe(false);
    });

    it('stringifies a non-JSON-serialisable extracted value into the failure reasoning', async () => {
      const node = makeNode({ type: 'jsonpath', target_key: 'm', path: '$.n', assertion: { op: 'gt', value: 5 } });

      const action = await executeVerifierNode(node, makeStateView({ m: { n: 10n } }), 1, makeCtx());

      const result = action.payload.updates.verify_verification as { passed: boolean; reasoning: string };
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('10');
    });

    it('refuses a nested-quantifier ReDoS pattern (fails closed, no backtracking)', async () => {
      const node = makeNode({
        type: 'jsonpath',
        target_key: 'doc',
        path: '$.text',
        assertion: { op: 'matches', pattern: '(a+)+$' },
      });
      const backtrackingBomb = 'a'.repeat(40) + '!';
      const start = Date.now();
      const result = await executeVerifierNode(node, makeStateView({ doc: { text: backtrackingBomb } }), 1, makeCtx());
      expect(Date.now() - start).toBeLessThan(1000);
      expect(result.payload.updates.verify_verification_passed).toBe(false);
    });
  });

  describe('llm_judge variant', () => {
    it('passes at/above threshold and records evaluator tokens', async () => {
      const evaluate = vi.fn().mockResolvedValue({ score: 0.9, reasoning: 'good', tokensUsed: 120 });
      const node = makeNode({
        type: 'llm_judge',
        target_key: 'draft',
        evaluator_agent_id: 'judge',
        pass_threshold: 0.8,
      });
      const action = await executeVerifierNode(node, makeStateView({ draft: 'text' }), 1, makeCtx(evaluate));
      expect(action.payload.updates.verify_verification_passed).toBe(true);
      expect(action.metadata.token_usage?.totalTokens).toBe(120);
      expect(evaluate).toHaveBeenCalledWith('judge', 'verify the work', 'text', undefined);
    });

    it('fails below threshold', async () => {
      const evaluate = vi.fn().mockResolvedValue({ score: 0.5, reasoning: 'weak', tokensUsed: 50 });
      const node = makeNode({
        type: 'llm_judge',
        target_key: 'draft',
        evaluator_agent_id: 'judge',
        pass_threshold: 0.8,
      });
      const action = await executeVerifierNode(node, makeStateView({ draft: 'text' }), 1, makeCtx(evaluate));
      expect(action.payload.updates.verify_verification_passed).toBe(false);
    });
  });

  describe('throw_on_fail', () => {
    it('throws VerificationFailedError when failing and throw_on_fail is set', async () => {
      const node = makeNode({
        type: 'expression',
        expression: 'memory.score > 5',
        throw_on_fail: true,
      });
      await expect(
        executeVerifierNode(node, makeStateView({ score: 1 }), 1, makeCtx()),
      ).rejects.toBeInstanceOf(VerificationFailedError);
    });

    it('does NOT throw when passing even with throw_on_fail set', async () => {
      const node = makeNode({
        type: 'expression',
        expression: 'memory.score > 5',
        throw_on_fail: true,
      });
      const action = await executeVerifierNode(node, makeStateView({ score: 9 }), 1, makeCtx());
      expect(action.payload.updates.verify_verification_passed).toBe(true);
    });
  });
});

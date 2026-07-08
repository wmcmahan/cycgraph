/**
 * verifier.test.ts — the verifier node executor (llm_judge / expression / jsonpath)
 */
import { describe, test, expect, vi } from 'vitest';
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
  test('throws NodeConfigError when verifier_config is missing', async () => {
    await expect(
      executeVerifierNode(makeNode(undefined), makeStateView({}), 1, makeCtx()),
    ).rejects.toBeInstanceOf(NodeConfigError);
  });

  describe('expression variant', () => {
    test('passes when the filtrex expression is truthy', async () => {
      const node = makeNode({ type: 'expression', expression: 'memory.score > 5' });
      const action = await executeVerifierNode(node, makeStateView({ score: 9 }), 1, makeCtx());
      expect(action.payload.updates.verify_verification_passed).toBe(true);
      const result = action.payload.updates.verify_verification as { type: string; passed: boolean };
      expect(result.type).toBe('expression');
      expect(result.passed).toBe(true);
    });

    test('fails when the expression is falsy', async () => {
      const node = makeNode({ type: 'expression', expression: 'memory.score > 5' });
      const action = await executeVerifierNode(node, makeStateView({ score: 2 }), 1, makeCtx());
      expect(action.payload.updates.verify_verification_passed).toBe(false);
    });

    test('honors a custom result_key', async () => {
      const node = makeNode({ type: 'expression', expression: 'memory.count >= 1', result_key: 'gate' });
      const action = await executeVerifierNode(node, makeStateView({ count: 3 }), 1, makeCtx());
      expect(action.payload.updates.gate_passed).toBe(true);
      expect(action.payload.updates.gate).toBeDefined();
    });
  });

  describe('jsonpath variant', () => {
    test('exists assertion', async () => {
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

    test('gte numeric assertion + extracted_value in result', async () => {
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

    test('matches regex assertion', async () => {
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

    test('refuses a nested-quantifier ReDoS pattern (fails closed, no backtracking)', async () => {
      const node = makeNode({
        type: 'jsonpath',
        target_key: 'doc',
        path: '$.text',
        assertion: { op: 'matches', pattern: '(a+)+$' }, // classic catastrophic backtracking
      });
      // A value that WOULD pin the event loop for this pattern on a backtracking
      // engine (mismatch after many 'a's, short enough to fit any input cap).
      const evil = 'a'.repeat(40) + '!';
      const start = Date.now();
      const result = await executeVerifierNode(node, makeStateView({ doc: { text: evil } }), 1, makeCtx());
      // The pattern is refused outright, so it returns immediately and fails.
      expect(Date.now() - start).toBeLessThan(1000);
      expect(result.payload.updates.verify_verification_passed).toBe(false);
    });
  });

  describe('llm_judge variant', () => {
    test('passes at/above threshold and records evaluator tokens', async () => {
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

    test('fails below threshold', async () => {
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
    test('throws VerificationFailedError when failing and throw_on_fail is set', async () => {
      const node = makeNode({
        type: 'expression',
        expression: 'memory.score > 5',
        throw_on_fail: true,
      });
      await expect(
        executeVerifierNode(node, makeStateView({ score: 1 }), 1, makeCtx()),
      ).rejects.toBeInstanceOf(VerificationFailedError);
    });

    test('does NOT throw when passing even with throw_on_fail set', async () => {
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

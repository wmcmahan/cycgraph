/**
 * Tests for the edge condition evaluator (runner/conditions.ts).
 */

import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../src/runner/conditions.js';
import { FILTREX_CACHE_SIZE } from '../src/runtime-config.js';
import { createTestState } from './helpers/factories.js';
import type { EdgeCondition, WorkflowState } from '../src/index.js';

const TAINT_META = { source: 'mcp_tool', tool_name: 'web_search', created_at: '2026-01-01T00:00:00.000Z' };

function stateWith(
  memory: Record<string, unknown>,
  taint_registry: Record<string, unknown> = {},
): WorkflowState {
  return createTestState({ memory, taint_registry });
}

describe('evaluateCondition', () => {
  describe('always', () => {
    it('returns true unconditionally', () => {
      expect(evaluateCondition({ type: 'always' }, stateWith({}))).toBe(true);
    });
  });

  describe('conditional truthiness', () => {
    it('returns true when the referenced key is truthy', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.approved' };

      expect(evaluateCondition(condition, stateWith({ approved: true }))).toBe(true);
    });

    it('returns false when the referenced key is falsy', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.approved' };

      expect(evaluateCondition(condition, stateWith({ approved: false }))).toBe(false);
    });

    it('returns false when the referenced key is absent', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.nonexistent' };

      expect(evaluateCondition(condition, stateWith({}))).toBe(false);
    });

    it('returns false when the condition string is missing', () => {
      expect(evaluateCondition({ type: 'conditional' }, stateWith({}))).toBe(false);
    });

    it('resolves nested paths', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.user.role == "admin"' };

      expect(evaluateCondition(condition, stateWith({ user: { role: 'admin' } }))).toBe(true);
    });
  });

  describe('conditional comparisons', () => {
    it('evaluates == on strings', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: "$.memory.decision == 'approve'" };

      expect(evaluateCondition(condition, stateWith({ decision: 'approve' }))).toBe(true);
    });

    it('evaluates != on strings', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: "$.memory.decision != 'reject'" };

      expect(evaluateCondition(condition, stateWith({ decision: 'approve' }))).toBe(true);
    });

    it('evaluates > on numbers', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.score > 80' };

      expect(evaluateCondition(condition, stateWith({ score: 85 }))).toBe(true);
    });

    it('evaluates < on numbers', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.score < 50' };

      expect(evaluateCondition(condition, stateWith({ score: 35 }))).toBe(true);
    });

    it('evaluates >= on numbers', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.score >= 70' };

      expect(evaluateCondition(condition, stateWith({ score: 70 }))).toBe(true);
    });

    it('evaluates <= on numbers', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: '$.memory.score <= 100' };

      expect(evaluateCondition(condition, stateWith({ score: 95 }))).toBe(true);
    });
  });

  describe('extra functions', () => {
    it('coerces a numeric string via number()', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'number(memory.score) >= 0.8' };

      expect(evaluateCondition(condition, stateWith({ score: '0.85' }))).toBe(true);
    });

    it('passes actual numbers through number() unchanged', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'number(memory.score) < 0.5' };

      expect(evaluateCondition(condition, stateWith({ score: 0.3 }))).toBe(true);
    });

    it('coerces a non-numeric string to 0 via number()', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'number(memory.score) == 0' };

      expect(evaluateCondition(condition, stateWith({ score: 'not-a-number' }))).toBe(true);
    });

    it('coerces an absent value to 0 via number()', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'number(memory.score) == 0' };

      expect(evaluateCondition(condition, stateWith({}))).toBe(true);
    });
  });

  describe('malformed expressions', () => {
    it('returns false when the expression fails to compile', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'invalid[path' };

      expect(evaluateCondition(condition, stateWith({}))).toBe(false);
    });

    it('returns false when filtrex yields an Error object at evaluation time', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'nosuchfn(memory.score)' };

      expect(evaluateCondition(condition, stateWith({ score: 1 }))).toBe(false);
    });
  });

  describe('taint checking', () => {
    it('warns but still evaluates a tainted reference by default', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'memory.decision == "go"' };
      const state = stateWith({ decision: 'go' }, { decision: TAINT_META });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    it('rejects a tainted reference under strict_taint', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'memory.decision == "go"' };
      const state = stateWith({ decision: 'go' }, { decision: TAINT_META });

      expect(evaluateCondition(condition, state, { strict_taint: true })).toBe(false);
    });

    it('allows a condition that references no tainted key under strict_taint', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'memory.safe_count > 0' };
      const state = stateWith({ safe_count: 5, tainted_data: 'evil' }, { tainted_data: TAINT_META });

      expect(evaluateCondition(condition, state, { strict_taint: true })).toBe(true);
    });

    it('handles an empty taint registry under strict_taint', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'memory.value > 5' };

      expect(evaluateCondition(condition, stateWith({ value: 10 }), { strict_taint: true })).toBe(true);
    });

    it('does not match a short tainted key inside a longer identifier', () => {
      const condition: EdgeCondition = { type: 'conditional', condition: 'memory.email == "safe"' };
      const state = stateWith({ email: 'safe', e: 'evil' }, { e: TAINT_META });

      expect(evaluateCondition(condition, state, { strict_taint: true })).toBe(true);
    });
  });

  describe('unknown condition type', () => {
    it('returns false for a type outside the known set', () => {
      const condition = { type: 'bogus' } as unknown as EdgeCondition;

      expect(evaluateCondition(condition, stateWith({}))).toBe(false);
    });

    it('returns false for the removed map type', () => {
      const condition = { type: 'map' } as unknown as EdgeCondition;

      expect(evaluateCondition(condition, stateWith({}))).toBe(false);
    });
  });

  describe('expression cache', () => {
    it('evaluates correctly past the eviction threshold', () => {
      const overflow = FILTREX_CACHE_SIZE + 5;

      const results = Array.from({ length: overflow }, (_, i) =>
        evaluateCondition(
          { type: 'conditional', condition: `memory.cache_key_${i} == ${i}` },
          stateWith({ [`cache_key_${i}`]: i }),
        ),
      );

      expect(results.every(Boolean)).toBe(true);
    });
  });
});

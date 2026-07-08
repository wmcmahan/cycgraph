import { describe, test, expect } from 'vitest';
import { evaluateCondition } from '../src/runner/conditions.js';
import type { WorkflowState, EdgeCondition } from '../src/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('Conditional Edge Evaluation', () => {
  const createMockState = (memory: Record<string, unknown>): WorkflowState => ({
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'test',
    constraints: [],
    status: 'running',
    current_node: 'test_node',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    max_execution_time_ms: 3600000,
    memory,
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
  });

  describe('always condition', () => {
    test('should always return true', () => {
      const condition: EdgeCondition = { type: 'always' };
      const state = createMockState({});

      expect(evaluateCondition(condition, state)).toBe(true);
    });
  });

  describe('conditional - JSONPath boolean check', () => {
    test('should return true if path exists and is truthy', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.approved'
      };
      const state = createMockState({ approved: true });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should return false if path exists but is false', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.approved'
      };
      const state = createMockState({ approved: false });

      expect(evaluateCondition(condition, state)).toBe(false);
    });

    test('should return false if path does not exist', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.nonexistent'
      };
      const state = createMockState({});

      expect(evaluateCondition(condition, state)).toBe(false);
    });
  });

  describe('conditional - JSONPath comparisons', () => {
    test('should evaluate == for string values', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: "$.memory.decision == 'approve'"
      };
      const state = createMockState({ decision: 'approve' });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should evaluate != for string values', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: "$.memory.decision != 'reject'"
      };
      const state = createMockState({ decision: 'approve' });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should evaluate > for numeric values', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.score > 80'
      };
      const state = createMockState({ score: 85 });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should evaluate < for numeric values', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.score < 50'
      };
      const state = createMockState({ score: 35 });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should evaluate >= for numeric values', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.score >= 70'
      };
      const state = createMockState({ score: 70 });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should evaluate <= for numeric values', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.score <= 100'
      };
      const state = createMockState({ score: 95 });

      expect(evaluateCondition(condition, state)).toBe(true);
    });
  });

  describe('number() coercion function', () => {
    test('should coerce string to number for comparison', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'number(memory.score) >= 0.8',
      };
      const state = createMockState({ score: '0.85' });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should work with actual numbers unchanged', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'number(memory.score) < 0.5',
      };
      const state = createMockState({ score: 0.3 });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should return 0 for non-numeric strings', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'number(memory.score) == 0',
      };
      const state = createMockState({ score: 'not-a-number' });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should return 0 for undefined values', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'number(memory.score) == 0',
      };
      const state = createMockState({});

      expect(evaluateCondition(condition, state)).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('should handle missing condition property', () => {
      const condition: EdgeCondition = { type: 'conditional' };
      const state = createMockState({});

      expect(evaluateCondition(condition, state)).toBe(false);
    });

    test('should handle nested paths', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: '$.memory.user.role == \"admin\"'
      };
      const state = createMockState({ user: { role: 'admin' } });

      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should return false for malformed JSONPath', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'invalid[path'
      };
      const state = createMockState({});

      expect(evaluateCondition(condition, state)).toBe(false);
    });
  });

  describe('taint checking', () => {
    test('should warn but allow tainted key references by default', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'memory.decision == "go"',
      };
      const state = createMockState({
        decision: 'go',
        _taint_registry: { decision: { source: 'mcp_tool', tool_name: 'web_search', created_at: new Date().toISOString() } },
      });

      // Default: warning only, still evaluates
      expect(evaluateCondition(condition, state)).toBe(true);
    });

    test('should reject tainted key references when strict_taint is true', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'memory.decision == "go"',
      };
      const state = createMockState({
        decision: 'go',
        _taint_registry: { decision: { source: 'mcp_tool', tool_name: 'web_search', created_at: new Date().toISOString() } },
      });

      expect(evaluateCondition(condition, state, { strict_taint: true })).toBe(false);
    });

    test('should allow conditions not referencing tainted keys even in strict mode', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'memory.safe_count > 0',
      };
      const state = createMockState({
        safe_count: 5,
        tainted_data: 'evil',
        _taint_registry: { tainted_data: { source: 'mcp_tool', tool_name: 'web_search', created_at: new Date().toISOString() } },
      });

      expect(evaluateCondition(condition, state, { strict_taint: true })).toBe(true);
    });

    test('should handle empty taint registry without issues', () => {
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'memory.value > 5',
      };
      const state = createMockState({ value: 10 });

      expect(evaluateCondition(condition, state, { strict_taint: true })).toBe(true);
    });

    test('short tainted key does not spuriously match a longer identifier', () => {
      // A tainted key "e" must not reject `memory.email == "x"`: the match is
      // boundary-aware on `memory.<key>`, not a bare substring.
      const condition: EdgeCondition = {
        type: 'conditional',
        condition: 'memory.email == "safe"',
      };
      const state = createMockState({
        email: 'safe',
        e: 'evil',
        _taint_registry: { e: { source: 'mcp_tool', created_at: new Date().toISOString() } },
      });

      expect(evaluateCondition(condition, state, { strict_taint: true })).toBe(true);
    });
  });
});

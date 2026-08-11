import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreakerManager } from '../src/execution/engine/circuit-breaker.js';
import type { GraphNode } from '../src/graph/graph.js';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node-1',
    type: 'agent',
    read_keys: ['*'],
    write_keys: [],
    failure_policy: {
      max_retries: 3,
      backoff_strategy: 'exponential',
      initial_backoff_ms: 1000,
      max_backoff_ms: 60000,
      circuit_breaker: {
        enabled: true,
        failure_threshold: 3,
        success_threshold: 2,
        timeout_ms: 5000,
      },
    },
    requires_compensation: false,
    ...overrides,
  } as GraphNode;
}

describe('CircuitBreakerManager', () => {
  let manager: CircuitBreakerManager;
  const nodes = [makeNode()];

  beforeEach(() => {
    manager = new CircuitBreakerManager();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('check should pass for unknown node (no state yet)', () => {
      expect(() => manager.check(makeNode())).not.toThrow();
    });

    it('update creates initial closed state', () => {
      manager.update('node-1', true, nodes);
      expect(() => manager.check(makeNode())).not.toThrow();
    });
  });

  describe('closed -> open transition', () => {
    it('should open after reaching failure threshold', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow('Circuit breaker open for node node-1');
    });

    it('should use default threshold of 5 when not configured', () => {
      const node = makeNode({
        failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      } as Partial<GraphNode>);
      const nodesDefault = [node];

      for (let i = 0; i < 4; i++) {
        manager.update('node-1', false, nodesDefault);
      }
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodesDefault);
      expect(() => manager.check(node)).toThrow();
    });

    it('successes should reset failure count', () => {
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', true, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      expect(() => manager.check(makeNode())).not.toThrow();
    });
  });

  describe('open -> half-open transition (timeout)', () => {
    it('should stay open before timeout elapses', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      vi.advanceTimersByTime(3000);
      expect(() => manager.check(node)).toThrow();
    });

    it('should transition to half-open after timeout', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      vi.advanceTimersByTime(6000);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('half-open -> closed transition', () => {
    it('should close after success threshold in half-open', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      vi.advanceTimersByTime(6000);
      manager.check(node);

      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);

      vi.advanceTimersByTime(0);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('half-open -> open transition (failure during half-open)', () => {
    it('should reopen immediately on failure in half-open', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      vi.advanceTimersByTime(6000);
      manager.check(node);

      manager.update('node-1', false, nodes);

      expect(() => manager.check(node)).toThrow();
    });
  });

  describe('multiple nodes', () => {
    it('should track each node independently', () => {
      const node1 = makeNode({ id: 'node-1' });
      const node2 = makeNode({ id: 'node-2' });
      const allNodes = [node1, node2];

      manager.update('node-1', false, allNodes);
      manager.update('node-1', false, allNodes);
      manager.update('node-1', false, allNodes);

      expect(() => manager.check(node1)).toThrow();
      expect(() => manager.check(node2)).not.toThrow();
    });
  });

  describe('default timeout', () => {
    it('should use 60000ms default when timeout_ms not configured', () => {
      const node = makeNode({
        failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      } as Partial<GraphNode>);
      const nodesDefault = [node];

      for (let i = 0; i < 5; i++) {
        manager.update('node-1', false, nodesDefault);
      }

      vi.advanceTimersByTime(59000);
      expect(() => manager.check(node)).toThrow();

      vi.advanceTimersByTime(2000);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('rapid state cycling', () => {
    it('should handle open→half-open→open→half-open→closed cycling', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();

      vi.advanceTimersByTime(6000);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();

      vi.advanceTimersByTime(6000);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);

      expect(() => manager.check(node)).not.toThrow();
    });

    it('should handle multiple rapid open→half-open→open cycles before closing', () => {
      const node = makeNode();

      for (let i = 0; i < 3; i++) manager.update('node-1', false, nodes);

      for (let cycle = 0; cycle < 3; cycle++) {
        expect(() => manager.check(node)).toThrow();
        vi.advanceTimersByTime(6000);
        manager.check(node);
        manager.update('node-1', false, nodes);
      }

      vi.advanceTimersByTime(6000);
      manager.check(node);
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('concurrent updates', () => {
    it('multiple rapid failures should consistently hit threshold', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      expect(() => manager.check(node)).toThrow();
    });

    it('interleaved successes and failures should reflect final state', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', true, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      expect(() => manager.check(node)).toThrow();
    });

    it('rapid successes after failures should keep breaker closed', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);

      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('success on a node that was never tracked creates initial state', () => {
      const node = makeNode({ id: 'fresh-node' });
      const allNodes = [node];

      manager.update('fresh-node', true, allNodes);

      expect(() => manager.check(node)).not.toThrow();
    });

    it('multiple nodes with different threshold configs', () => {
      const strictNode = makeNode({
        id: 'strict',
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
          circuit_breaker: {
            enabled: true,
            failure_threshold: 1,
            success_threshold: 3,
            timeout_ms: 10000,
          },
        },
      } as Partial<GraphNode>);

      const lenientNode = makeNode({
        id: 'lenient',
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
          circuit_breaker: {
            enabled: true,
            failure_threshold: 5,
            success_threshold: 1,
            timeout_ms: 2000,
          },
        },
      } as Partial<GraphNode>);

      const allNodes = [strictNode, lenientNode];

      manager.update('strict', false, allNodes);
      manager.update('lenient', false, allNodes);

      expect(() => manager.check(strictNode)).toThrow();
      expect(() => manager.check(lenientNode)).not.toThrow();

      for (let i = 0; i < 4; i++) manager.update('lenient', false, allNodes);
      expect(() => manager.check(lenientNode)).toThrow();
    });

    it('check on half-open state allows execution', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      vi.advanceTimersByTime(6000);
      manager.check(node);

      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('failure count reset on success in closed state', () => {
    it('single success after partial failures resets count to zero', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', true, nodes);

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();
    });

    it('repeated reset cycles keep breaker closed', () => {
      const node = makeNode();

      for (let cycle = 0; cycle < 5; cycle++) {
        manager.update('node-1', false, nodes);
        manager.update('node-1', false, nodes);
        manager.update('node-1', true, nodes);
      }

      expect(() => manager.check(node)).not.toThrow();
    });

    it('success at exactly threshold minus one prevents tripping', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      manager.update('node-1', true, nodes);

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('default success threshold', () => {
    it('closes from half-open using the default success threshold when unconfigured', () => {
      const node = makeNode({
        id: 'node-1',
        failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      } as Partial<GraphNode>);
      const nodesDefault = [node];

      for (let i = 0; i < 5; i++) manager.update('node-1', false, nodesDefault);
      vi.advanceTimersByTime(61000);
      manager.check(node);

      manager.update('node-1', true, nodesDefault);
      manager.update('node-1', true, nodesDefault);

      manager.update('node-1', false, nodesDefault);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('failure while already open', () => {
    it('stays open when a failure is recorded before the timeout elapses', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();

      manager.update('node-1', false, nodes);

      expect(() => manager.check(node)).toThrow();
    });
  });

  describe('half-open success count accumulation', () => {
    it('success_count increments properly in half-open', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      vi.advanceTimersByTime(6000);
      manager.check(node);

      manager.update('node-1', true, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', true, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();
    });

    it('exactly at success_threshold transitions to closed', () => {
      const node = makeNode({
        id: 'node-1',
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
          circuit_breaker: {
            enabled: true,
            failure_threshold: 3,
            success_threshold: 3,
            timeout_ms: 5000,
          },
        },
      } as Partial<GraphNode>);
      const customNodes = [node];

      for (let i = 0; i < 3; i++) manager.update('node-1', false, customNodes);

      vi.advanceTimersByTime(6000);
      manager.check(node);

      manager.update('node-1', true, customNodes);
      manager.update('node-1', true, customNodes);

      manager.update('node-1', true, customNodes);

      manager.update('node-1', false, customNodes);
      manager.update('node-1', false, customNodes);
      expect(() => manager.check(node)).not.toThrow();
    });

    it('failure during half-open resets success_count', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      vi.advanceTimersByTime(6000);
      manager.check(node);

      manager.update('node-1', true, nodes);

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();

      vi.advanceTimersByTime(6000);
      manager.check(node);

      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);
      expect(() => manager.check(node)).not.toThrow();
    });
  });
});

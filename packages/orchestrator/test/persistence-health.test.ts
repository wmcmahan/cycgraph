import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  persistWorkflow,
  getPersistenceHealth,
  resetPersistenceHealth,
  PersistenceUnavailableError,
} from '../src/db/persistence-health.js';
import type { PersistenceProvider } from '../src/persistence/interfaces.js';
import type { WorkflowState } from '../src/types/state.js';

// Mock logger to silence output
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    goal: 'Test goal',
    constraints: ['be fast'],
    status: 'running',
    current_node: 'node-1',
    iteration_count: 5,
    retry_count: 0,
    max_retries: 3,
    memory: { key: 'value' },
    visited_nodes: ['start', 'node-1'],
    max_iterations: 50,
    compensation_stack: [],
    max_execution_time_ms: 3600000,
    total_tokens_used: 100,
    total_cost_usd: 0.5,
    supervisor_history: [],
    ...overrides,
  };
}

function makeProvider(overrides: Partial<PersistenceProvider> = {}): PersistenceProvider {
  return {
    saveWorkflowRun: vi.fn().mockResolvedValue(undefined),
    saveWorkflowState: vi.fn().mockResolvedValue(undefined),
    loadLatestWorkflowState: vi.fn(),
    loadWorkflowRun: vi.fn(),
    saveGraph: vi.fn(),
    loadGraph: vi.fn(),
    ...overrides,
  } as unknown as PersistenceProvider;
}

describe('Persistence Health', () => {
  beforeEach(() => {
    resetPersistenceHealth();
  });

  // ─── persistWorkflow ──────────────────────────────────────────────

  describe('persistWorkflow', () => {
    it('resets consecutive failures on success', async () => {
      const provider = makeProvider();
      const state = makeState();

      await persistWorkflow(state, provider);

      const health = getPersistenceHealth();
      expect(health.consecutiveFailures).toBe(0);
      expect(health.totalSuccesses).toBe(1);
      expect(health.lastSuccessAt).toBeInstanceOf(Date);
    });

    it('calls both saveWorkflowRun and saveWorkflowState', async () => {
      const provider = makeProvider();
      const state = makeState();

      await persistWorkflow(state, provider);

      expect(provider.saveWorkflowRun).toHaveBeenCalledWith(state);
      expect(provider.saveWorkflowState).toHaveBeenCalledWith(state);
    });

    it('increments failure counter on error', async () => {
      const provider = makeProvider({
        saveWorkflowRun: vi.fn().mockRejectedValue(new Error('DB down')),
      });
      const state = makeState();

      // First failure — should NOT throw (below threshold)
      await persistWorkflow(state, provider);

      const health = getPersistenceHealth();
      expect(health.consecutiveFailures).toBe(1);
      expect(health.totalFailures).toBe(1);
      expect(health.lastFailureAt).toBeInstanceOf(Date);
    });

    it('throws PersistenceUnavailableError at threshold (default 3)', async () => {
      const provider = makeProvider({
        saveWorkflowRun: vi.fn().mockRejectedValue(new Error('DB down')),
      });
      const state = makeState();

      // Failures 1 and 2 — below threshold
      await persistWorkflow(state, provider);
      await persistWorkflow(state, provider);

      // Failure 3 — at threshold, should throw
      await expect(persistWorkflow(state, provider)).rejects.toThrow(PersistenceUnavailableError);

      const health = getPersistenceHealth();
      expect(health.consecutiveFailures).toBe(3);
      expect(health.totalFailures).toBe(3);
    });

    it('resets failure counter after a success', async () => {
      const failingProvider = makeProvider({
        saveWorkflowRun: vi.fn().mockRejectedValue(new Error('DB down')),
      });
      const successProvider = makeProvider();
      const state = makeState();

      // Two failures
      await persistWorkflow(state, failingProvider);
      await persistWorkflow(state, failingProvider);
      expect(getPersistenceHealth().consecutiveFailures).toBe(2);

      // One success resets
      await persistWorkflow(state, successProvider);
      expect(getPersistenceHealth().consecutiveFailures).toBe(0);
      expect(getPersistenceHealth().totalSuccesses).toBe(1);
    });
  });

  // ─── resetPersistenceHealth ───────────────────────────────────────

  describe('resetPersistenceHealth', () => {
    it('zeroes all metrics', async () => {
      const provider = makeProvider({
        saveWorkflowRun: vi.fn().mockRejectedValue(new Error('fail')),
      });
      await persistWorkflow(makeState(), provider);

      resetPersistenceHealth();

      const health = getPersistenceHealth();
      expect(health.consecutiveFailures).toBe(0);
      expect(health.lastSuccessAt).toBeNull();
      expect(health.lastFailureAt).toBeNull();
      expect(health.totalFailures).toBe(0);
      expect(health.totalSuccesses).toBe(0);
    });
  });

  // ─── getPersistenceHealth ─────────────────────────────────────────

  describe('getPersistenceHealth', () => {
    it('returns a snapshot (mutations do not affect internal state)', () => {
      const health = getPersistenceHealth();
      (health as any).consecutiveFailures = 999;

      expect(getPersistenceHealth().consecutiveFailures).toBe(0);
    });
  });

  // ─── PersistenceUnavailableError ──────────────────────────────────

  describe('PersistenceUnavailableError', () => {
    it('is an Error subclass with correct name', () => {
      const err = new PersistenceUnavailableError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('PersistenceUnavailableError');
      expect(err.message).toBe('test');
    });
  });
});

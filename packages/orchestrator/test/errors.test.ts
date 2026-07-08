import { describe, it, expect } from 'vitest';
import {
  CycgraphError,
  BudgetExceededError,
  WorkflowTimeoutError,
  NodeConfigError,
  AgentNotFoundError,
  MCPServerNotFoundError,
  StaleClaimError,
  ArchitectError,
  SupervisorConfigError,
  EventSequenceConflictError,
  PersistenceUnavailableError,
} from '../src/index.js';

// Every engine error must be catchable as a single group via the shared
// CycgraphError base — while remaining a real Error and keeping its own name.
describe('CycgraphError base class', () => {
  const samples: Array<[string, Error]> = [
    ['BudgetExceededError', new BudgetExceededError(100, 50)],
    ['WorkflowTimeoutError', new WorkflowTimeoutError('wf', 'run', 1000)],
    ['NodeConfigError', new NodeConfigError('n1', 'map', 'items')],
    ['AgentNotFoundError', new AgentNotFoundError('a1')],
    ['MCPServerNotFoundError', new MCPServerNotFoundError('s1')],
    ['StaleClaimError', new StaleClaimError('run', 1, 2)],
    ['ArchitectError', new ArchitectError('boom')],
    ['SupervisorConfigError', new SupervisorConfigError('sup', 'missing config')],
    ['EventSequenceConflictError', new EventSequenceConflictError('run', 3)],
    ['PersistenceUnavailableError', new PersistenceUnavailableError('db down')],
  ];

  it.each(samples)('%s is a CycgraphError and an Error with its own name', (name, err) => {
    expect(err).toBeInstanceOf(CycgraphError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(name);
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('lets a consumer catch any engine error as one group', () => {
    const caught: unknown = (() => {
      try {
        throw new NodeConfigError('n', 'agent', 'agent_id');
      } catch (e) {
        return e;
      }
    })();
    expect(caught instanceof CycgraphError).toBe(true);
    // A non-engine error is NOT a CycgraphError.
    expect(new TypeError('x') instanceof CycgraphError).toBe(false);
  });
});

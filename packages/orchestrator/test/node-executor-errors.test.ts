/**
 * node-executor-errors.test.ts — the typed errors thrown by node executors
 * (VerificationFailedError, MemoryWriterMissingError, SubgraphIncompleteError).
 */
import { describe, it, expect } from 'vitest';
import {
  VerificationFailedError,
  MemoryWriterMissingError,
  SubgraphIncompleteError,
} from '../src/runner/node-executors/errors.js';
import { CycgraphError } from '../src/errors.js';
import type { VerificationResult } from '../src/types/graph.js';

describe('VerificationFailedError', () => {
  const result: VerificationResult = {
    type: 'expression',
    passed: false,
    reasoning: 'score below threshold',
    evaluated_at: '2026-08-01T00:00:00.000Z',
  };

  it('extends CycgraphError', () => {
    expect(new VerificationFailedError('verify', result)).toBeInstanceOf(CycgraphError);
  });

  it('carries the node id and verification result', () => {
    const err = new VerificationFailedError('verify', result);

    expect(err.nodeId).toBe('verify');
    expect(err.result).toBe(result);
  });

  it('names itself and embeds the reasoning in the message', () => {
    const err = new VerificationFailedError('verify', result);

    expect(err.name).toBe('VerificationFailedError');
    expect(err.message).toBe('Verification failed for node "verify": score below threshold');
  });
});

describe('MemoryWriterMissingError', () => {
  it('extends CycgraphError', () => {
    expect(new MemoryWriterMissingError('reflect')).toBeInstanceOf(CycgraphError);
  });

  it('carries the node id', () => {
    expect(new MemoryWriterMissingError('reflect').nodeId).toBe('reflect');
  });

  it('names itself and names the missing memoryWriter in the message', () => {
    const err = new MemoryWriterMissingError('reflect');

    expect(err.name).toBe('MemoryWriterMissingError');
    expect(err.message).toContain('Reflection node "reflect"');
    expect(err.message).toContain('memoryWriter');
  });
});

describe('SubgraphIncompleteError', () => {
  it('extends CycgraphError', () => {
    expect(new SubgraphIncompleteError('sub', 'child-graph', 'cancelled')).toBeInstanceOf(CycgraphError);
  });

  it('carries the node id, subgraph id, and terminal status', () => {
    const err = new SubgraphIncompleteError('sub', 'child-graph', 'cancelled');

    expect(err.nodeId).toBe('sub');
    expect(err.subgraphId).toBe('child-graph');
    expect(err.status).toBe('cancelled');
  });

  it('names itself and embeds the subgraph id and status in the message', () => {
    const err = new SubgraphIncompleteError('sub', 'child-graph', 'cancelled');

    expect(err.name).toBe('SubgraphIncompleteError');
    expect(err.message).toBe('Subgraph "child-graph" did not complete (status: cancelled)');
  });
});

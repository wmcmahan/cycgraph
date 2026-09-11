/**
 * Tests for task-state translation of the protobuf enum numbers that
 * `Task.fromJSON` actually emits on the wire.
 */

import { describe, it, expect } from 'vitest';
import { isPending, normalizeState } from '../src/task-state.js';

describe('normalizeState', () => {
  it('maps each settled protobuf enum number to its engine state', () => {
    expect(normalizeState(3)).toBe('completed');
    expect(normalizeState(4)).toBe('failed');
    expect(normalizeState(5)).toBe('canceled');
    expect(normalizeState(6)).toBe('input-required');
    expect(normalizeState(7)).toBe('rejected');
    expect(normalizeState(8)).toBe('auth-required');
  });

  it('maps a settled enum number written as a string to the same state', () => {
    expect(normalizeState('3')).toBe('completed');
    expect(normalizeState('4')).toBe('failed');
    expect(normalizeState('5')).toBe('canceled');
    expect(normalizeState('6')).toBe('input-required');
    expect(normalizeState('7')).toBe('rejected');
    expect(normalizeState('8')).toBe('auth-required');
  });

  it('maps the enum number, proto name and json wire form of a state identically', () => {
    expect([normalizeState(6), normalizeState('TASK_STATE_INPUT_REQUIRED'), normalizeState('input-required')])
      .toEqual(['input-required', 'input-required', 'input-required']);
    expect([normalizeState(7), normalizeState('TASK_STATE_REJECTED'), normalizeState('rejected')])
      .toEqual(['rejected', 'rejected', 'rejected']);
    expect([normalizeState(8), normalizeState('TASK_STATE_AUTH_REQUIRED'), normalizeState('auth-required')])
      .toEqual(['auth-required', 'auth-required', 'auth-required']);
  });

  it('maps a running enum number to failure so a deadline never reads as success', () => {
    expect(normalizeState(1)).toBe('failed');
    expect(normalizeState(2)).toBe('failed');
  });

  it('maps the unspecified and unknown enum numbers to failure', () => {
    expect(normalizeState(0)).toBe('failed');
    expect(normalizeState(9)).toBe('failed');
  });
});

describe('isPending', () => {
  it('treats the running enum numbers as pending', () => {
    expect(isPending(1)).toBe(true);
    expect(isPending(2)).toBe(true);
  });

  it('treats a running enum number written as a string as pending', () => {
    expect(isPending('1')).toBe(true);
    expect(isPending('2')).toBe(true);
  });

  it('treats the proto names and json wire forms of the running states as pending', () => {
    expect(isPending('TASK_STATE_SUBMITTED')).toBe(true);
    expect(isPending('submitted')).toBe(true);
    expect(isPending('TASK_STATE_WORKING')).toBe(true);
    expect(isPending('working')).toBe(true);
  });

  it('treats every settled enum number as not pending', () => {
    expect(isPending(3)).toBe(false);
    expect(isPending(4)).toBe(false);
    expect(isPending(5)).toBe(false);
    expect(isPending(6)).toBe(false);
    expect(isPending(7)).toBe(false);
    expect(isPending(8)).toBe(false);
  });

  it('treats the unspecified and unknown enum numbers as not pending', () => {
    expect(isPending(0)).toBe(false);
    expect(isPending(9)).toBe(false);
    expect(isPending(undefined)).toBe(false);
  });
});

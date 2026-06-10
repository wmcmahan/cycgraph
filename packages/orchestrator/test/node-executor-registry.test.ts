/**
 * node-executor-registry.test.ts — the node-type executor registry
 */
import { describe, test, expect } from 'vitest';
import {
  NODE_EXECUTORS,
  SUPPORTED_NODE_TYPES,
  getNodeExecutor,
} from '../src/runner/node-executors/registry.js';
import { NodeTypeSchema } from '../src/types/graph.js';

describe('node executor registry', () => {
  test('registers an executor for every NodeType in the schema', () => {
    const schemaTypes = NodeTypeSchema.options.slice().sort();
    const registryTypes = [...SUPPORTED_NODE_TYPES].sort();
    // The registry's Record<NodeType, ...> type enforces this at compile time;
    // this asserts the schema and registry haven't drifted at runtime either.
    expect(registryTypes).toEqual(schemaTypes);
  });

  test('getNodeExecutor returns a function for every supported type', () => {
    for (const type of SUPPORTED_NODE_TYPES) {
      expect(typeof getNodeExecutor(type)).toBe('function');
      expect(NODE_EXECUTORS[type]).toBeDefined();
    }
  });

  test('getNodeExecutor returns undefined for an unknown type', () => {
    expect(getNodeExecutor('not-a-real-type' as never)).toBeUndefined();
  });
});

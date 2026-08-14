/**
 * verifier — check a memory value and record a structured outcome
 *
 * Three ways to check, exposed as three functions on one namespace. They are a
 * discriminated union inside a single config rather than three node types, and
 * all three write the same pair of keys, so downstream edges branch on
 * `${resultKey}_passed` identically whichever one produced the result.
 *
 * Each function leads with what it checks with: the judging agent, the
 * expression, the target key. Result keys are implied by the node type, so no
 * spec here takes `writes`.
 *
 * @module authoring/verifier
 */

import type { VerifierJsonPathAssertion } from '../graph/graph.js';
import type { AgentValue } from './agent.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Fields every verifier variant accepts. */
interface VerifierCommonSpec extends NodeCommon {
  /**
   * Key prefix for the outcome. Defaults to `${id}_verification`, with the
   * boolean at `${resultKey}_passed`.
   */
  resultKey?: string;
  /**
   * Throw on failure to trigger `failure_policy` retry. Left false, the node
   * always succeeds and downstream edges route on the `_passed` key.
   */
  throwOnFail?: boolean;
  /** What this verifier checks, for readers. */
  description?: string;
}

/** Spec for {@link verifier.llmJudge}. */
export interface VerifierLLMJudgeSpec extends VerifierCommonSpec {
  /** Memory key whose value is scored. */
  target: string;
  /** Pass when the score is at or above this, on a 0–1 scale. */
  threshold?: number;
  /** Extra instruction for the judging agent. */
  criteria?: string;
}

/** Spec for {@link verifier.expression}. */
export type VerifierExpressionSpec = VerifierCommonSpec;

/** Spec for {@link verifier.jsonPath}. */
export interface VerifierJsonPathSpec extends VerifierCommonSpec {
  /** JSONPath evaluated against the target value. */
  path: string;
  /** Assertion applied to the first extracted value. */
  assertion: VerifierJsonPathAssertion;
}

function verifierNode(config: Record<string, unknown>, spec: VerifierCommonSpec): NodeValue {
  const { resultKey, throwOnFail, description, ...placement } = spec;

  return {
    ...placement,
    type: 'verifier' as const,
    verifierConfig: {
      ...config,
      ...(resultKey !== undefined ? { resultKey } : {}),
      ...(throwOnFail !== undefined ? { throwOnFail } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue;
}

/**
 * Author a `verifier` node.
 *
 * `llmJudge` costs a model call; `expression` and `jsonPath` are deterministic
 * and free.
 */
export const verifier = {
  /**
   * Score a memory value with a judging agent.
   *
   * @param judge - The evaluator agent.
   * @param spec - Placement, the target key, and the pass threshold.
   */
  llmJudge(judge: AgentValue | string, spec: VerifierLLMJudgeSpec): NodeValue {
    const { target, threshold, criteria, ...common } = spec;
    return verifierNode(
      {
        type: 'llm_judge',
        targetKey: target,
        evaluatorAgentId: judge,
        ...(threshold !== undefined ? { passThreshold: threshold } : {}),
        ...(criteria !== undefined ? { evaluationCriteria: criteria } : {}),
      },
      common,
    );
  },

  /**
   * Evaluate a filtrex expression against `{ memory, goal }`. Passes when the
   * expression is truthy.
   *
   * @param expression - The filtrex expression.
   * @param spec - Placement and result handling.
   */
  expression(expression: string, spec: VerifierExpressionSpec): NodeValue {
    return verifierNode({ type: 'expression', expression }, spec);
  },

  /**
   * Extract a value by JSONPath, then assert on it.
   *
   * @param target - Memory key whose value is queried.
   * @param spec - Placement, the path, and the assertion.
   */
  jsonPath(target: string, spec: VerifierJsonPathSpec): NodeValue {
    const { path, assertion, ...common } = spec;
    return verifierNode({ type: 'jsonpath', targetKey: target, path, assertion }, common);
  },
};

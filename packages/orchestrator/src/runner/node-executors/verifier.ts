/**
 * Verifier Executor
 *
 * Compound-systems primitive that gates a target memory key against a
 * verification predicate. Three deterministic-or-probabilistic flavours:
 *
 *   - `llm_judge`  — evaluator agent scores the target; pass at threshold.
 *   - `expression` — filtrex predicate against workflow memory.
 *   - `jsonpath`   — JSONPath extraction + structural assertion.
 *
 * Outcomes are written as a structured {@link VerificationResult} object
 * plus a flat `_passed` boolean. By default the node always succeeds and
 * downstream edges route on the outcome; set `throw_on_fail: true` to opt
 * into `failure_policy`-driven retry instead.
 *
 * @module runner/node-executors/verifier
 */

import { JSONPath } from 'jsonpath-plus';
import { compileExpression } from 'filtrex';
import { v4 as uuidv4 } from 'uuid';

import type { GraphNode, VerifierConfig, VerificationResult, VerifierJsonPathAssertion } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { FILTREX_COMPILE_OPTIONS, normalizeConditionExpression } from '../../utils/condition-expression.js';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { VerificationFailedError } from './errors.js';

const logger = createLogger('runner.node.verifier');

/**
 * Execute a verifier node.
 *
 * Dispatches to the variant indicated by `verifier_config.type`, writes
 * the structured outcome to memory, and (optionally) throws on failure to
 * engage the node's `failure_policy` retry.
 *
 * @param node - Verifier node with `verifier_config`.
 * @param stateView - Filtered state view (must include `target_key` in `read_keys`).
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context with injected dependencies.
 * @returns `update_memory` action carrying the {@link VerificationResult}.
 * @throws {NodeConfigError} If `verifier_config` is missing.
 * @throws {VerificationFailedError} If verification fails and `throw_on_fail` is `true`.
 */
export async function executeVerifierNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.verifier_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'verifier', 'verifier_config');
  }

  logger.info('verifier_executing', {
    node_id: node.id,
    variant: config.type,
  });

  const { result, tokensUsed } = await runVerification(config, stateView, ctx);

  logger.info('verifier_complete', {
    node_id: node.id,
    variant: config.type,
    passed: result.passed,
    score: result.score,
  });

  if (!result.passed && config.throw_on_fail) {
    throw new VerificationFailedError(node.id, result);
  }

  const resultKey = config.result_key ?? `${node.id}_verification`;

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'update_memory',
    payload: {
      updates: {
        [resultKey]: result,
        [`${resultKey}_passed`]: result.passed,
      },
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      ...(tokensUsed > 0 ? { token_usage: { totalTokens: tokensUsed } } : {}),
    },
  };
}

// ─── Internals ──────────────────────────────────────────────────────

interface VerificationRun {
  result: VerificationResult;
  tokensUsed: number;
}

async function runVerification(
  config: VerifierConfig,
  stateView: StateView,
  ctx: NodeExecutorContext,
): Promise<VerificationRun> {
  const evaluatedAt = new Date().toISOString();

  switch (config.type) {
    case 'llm_judge': {
      const target = stateView.memory[config.target_key];
      const evalResult = await ctx.deps.evaluateQualityExecutor(
        config.evaluator_agent_id,
        stateView.goal,
        target,
        config.evaluation_criteria,
      );
      const passed = evalResult.score >= config.pass_threshold;
      return {
        result: {
          type: 'llm_judge',
          passed,
          reasoning: evalResult.reasoning,
          score: evalResult.score,
          threshold: config.pass_threshold,
          evaluated_at: evaluatedAt,
        },
        tokensUsed: evalResult.tokensUsed,
      };
    }

    case 'expression': {
      const expression = normalizeConditionExpression(config.expression);
      const compiled = compileExpression(expression, FILTREX_COMPILE_OPTIONS);
      const raw = compiled({ memory: stateView.memory, goal: stateView.goal });
      const passed = Boolean(raw);
      return {
        result: {
          type: 'expression',
          passed,
          reasoning: passed
            ? `expression "${config.expression}" evaluated truthy`
            : `expression "${config.expression}" evaluated falsy`,
          evaluated_at: evaluatedAt,
        },
        tokensUsed: 0,
      };
    }

    case 'jsonpath': {
      const target = stateView.memory[config.target_key];
      // JSONPath's typings reject `unknown`; we accept any JSON-shaped value
      // and let the path return [] if the input is incompatible.
      const extracted = JSONPath({ path: config.path, json: target as object }) as unknown[];
      const value = extracted[0];
      const passed = evaluateAssertion(value, config.assertion);
      return {
        result: {
          type: 'jsonpath',
          passed,
          reasoning: passed
            ? `assertion ${assertionDescription(config.assertion)} at ${config.path} passed`
            : `assertion ${assertionDescription(config.assertion)} at ${config.path} failed (value=${safeStringify(value)})`,
          extracted_value: value,
          evaluated_at: evaluatedAt,
        },
        tokensUsed: 0,
      };
    }
  }
}

/** Longest input a verifier regex is tested against (bounds polynomial-ReDoS worst case). */
const MAX_REGEX_INPUT = 10_000;

/**
 * Heuristic detector for the classic *exponential* ReDoS shape: a group whose
 * last token is an unbounded quantifier and which is itself quantified —
 * `(a+)+`, `(a*)*`, `(.+)+`, `(\d+){2,}`, etc. Catastrophic backtracking is
 * undecidable in general, so this is not exhaustive, but it blocks the common
 * exploit shapes that a length cap alone cannot (they explode at ~30 chars,
 * far below any usable input cap).
 */
function hasNestedQuantifier(pattern: string): boolean {
  return /[+*}]\s*\)\s*[+*]/.test(pattern) || /[+*}]\s*\)\s*\{\d*,?\d*\}/.test(pattern);
}

/**
 * Test a user/architect-supplied regex against a (possibly tainted) value with
 * ReDoS mitigations. The pattern length is schema-bounded; here we additionally
 * (a) refuse nested-quantifier patterns outright (fail closed) so exponential
 * backtracking can never run against a tainted value on the shared worker, and
 * (b) cap the matched input to bound the remaining polynomial cases. Invalid or
 * dangerous patterns simply cause the assertion to fail.
 */
function safeRegexTest(pattern: string, value: string): boolean {
  if (hasNestedQuantifier(pattern)) {
    logger.warn('verifier.regex_rejected_redos', { pattern });
    return false;
  }
  try {
    return new RegExp(pattern).test(value.slice(0, MAX_REGEX_INPUT));
  } catch {
    return false;
  }
}

function evaluateAssertion(value: unknown, assertion: VerifierJsonPathAssertion): boolean {
  switch (assertion.op) {
    case 'exists':
      return value !== undefined && value !== null;
    case 'equals':
      return value === assertion.value;
    case 'matches':
      return typeof value === 'string' && safeRegexTest(assertion.pattern, value);
    case 'gt':
      return typeof value === 'number' && value > assertion.value;
    case 'gte':
      return typeof value === 'number' && value >= assertion.value;
    case 'lt':
      return typeof value === 'number' && value < assertion.value;
    case 'lte':
      return typeof value === 'number' && value <= assertion.value;
  }
}

function assertionDescription(assertion: VerifierJsonPathAssertion): string {
  switch (assertion.op) {
    case 'exists':
      return 'exists';
    case 'equals':
      return `equals ${safeStringify(assertion.value)}`;
    case 'matches':
      return `matches /${assertion.pattern}/`;
    case 'gt':
      return `> ${assertion.value}`;
    case 'gte':
      return `>= ${assertion.value}`;
    case 'lt':
      return `< ${assertion.value}`;
    case 'lte':
      return `<= ${assertion.value}`;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// VerificationFailedError lives in './errors.js' (node-executor errors module).

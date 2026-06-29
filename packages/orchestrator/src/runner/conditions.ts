/**
 * Edge Condition Evaluator
 *
 * Evaluates edge conditions to determine routing in the graph.
 * Conditions are compiled via filtrex
 * with an LRU cache to avoid recompilation on repeated evaluations.
 *
 * Supported condition types:
 * - `always`: unconditionally true
 * - `conditional`: filtrex expression evaluated against workflow state
 * - `map`: syntactic sugar that delegates to `conditional`
 *
 * @module runner/conditions
 */

import { compileExpression, useDotAccessOperatorAndOptionalChaining } from 'filtrex';
import type { EdgeCondition } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import { createLogger } from '../utils/logger.js';
import { getTaintRegistry } from '../utils/taint.js';
import { FILTREX_CACHE_SIZE } from '../runtime-config.js';

const logger = createLogger('runner.conditions');

// ─── Filtrex Configuration ──────────────────────────────────────────

/**
 * Shared filtrex compile options. Used by both the runtime evaluator
 * and the graph validator so that `validateGraph()` rejects exactly the
 * set of expressions that `evaluateCondition()` cannot evaluate.
 */
export const FILTREX_EXTRA_FUNCTIONS = {
  length: (val: unknown) =>
    Array.isArray(val) ? val.length : typeof val === 'string' ? val.length : 0,
  lower: (val: unknown) =>
    typeof val === 'string' ? val.toLowerCase() : val,
  upper: (val: unknown) =>
    typeof val === 'string' ? val.toUpperCase() : val,
  typeof: (val: unknown) =>
    val === null ? 'null' : typeof val,
  includes: (arr: unknown, val: unknown) =>
    Array.isArray(arr) ? arr.includes(val) : false,
  number: (val: unknown) => {
    const n = Number(val);
    return Number.isNaN(n) ? 0 : n;
  },
} as const;

export const FILTREX_COMPILE_OPTIONS = {
  customProp: useDotAccessOperatorAndOptionalChaining,
  extraFunctions: FILTREX_EXTRA_FUNCTIONS,
} as const;

/**
 * Normalize a condition expression to the form that `filtrex` accepts.
 *
 * Applied identically by the validator (load time) and the runtime evaluator
 * so that an expression which passes validation will compile at runtime.
 *
 * Transformations:
 *   - Strip a leading `$.` (legacy JSONPath compatibility).
 *   - Replace single-quoted string literals with double quotes.
 */
export function normalizeConditionExpression(expression: string): string {
  let normalized = expression;
  if (normalized.startsWith('$.')) normalized = normalized.slice(2);
  normalized = normalized.replace(/'/g, '"');
  return normalized;
}

// ─── Expression Cache ───────────────────────────────────────────────

/**
 * LRU-style cache for compiled filtrex expressions.
 * Avoids recompiling the same condition string on every edge evaluation.
 */
const expressionCache = new Map<string, ReturnType<typeof compileExpression>>();

/**
 * Compile and cache a filtrex expression.
 *
 * @param expression - The expression string to compile.
 * @returns A function that evaluates the expression against a data object.
 */
function getCompiledExpression(expression: string): ReturnType<typeof compileExpression> {
  const cached = expressionCache.get(expression);
  if (cached) return cached;

  const fn = compileExpression(expression, FILTREX_COMPILE_OPTIONS);

  // Evict oldest entry if cache is full
  if (expressionCache.size >= FILTREX_CACHE_SIZE) {
    const oldest = expressionCache.keys().next().value;
    if (oldest !== undefined) expressionCache.delete(oldest);
  }

  expressionCache.set(expression, fn);
  return fn;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Evaluate an edge condition against the current workflow state.
 *
 * @example
 * ```ts
 * evaluateCondition({ type: 'conditional', condition: "memory.confidence > 0.8" }, state)
 * ```
 *
 * @param condition - The edge condition to evaluate.
 * @param state - Current workflow state.
 * @param options - Optional evaluation configuration.
 * @param options.strict_taint - When `true`, reject conditions that reference tainted memory keys.
 * @returns `true` if the edge should be followed.
 */
export function evaluateCondition(
  condition: EdgeCondition,
  state: WorkflowState,
  options?: { strict_taint?: boolean },
): boolean {
  switch (condition.type) {
    case 'always':
      return true;

    case 'conditional': {
      if (!condition.condition) return false;

      try {
        const expression = normalizeConditionExpression(condition.condition);

        // Check for tainted keys referenced in the condition expression
        const taintRegistry = getTaintRegistry(state.memory);
        const taintedKeys = Object.keys(taintRegistry);
        if (taintedKeys.length > 0) {
          const taintedKeysInExpr = taintedKeys.filter(
            key => expression.includes(`memory.${key}`) || expression.includes(key),
          );
          if (taintedKeysInExpr.length > 0) {
            if (options?.strict_taint) {
              logger.warn('tainted_condition_rejected', {
                condition: condition.condition,
                tainted_keys: taintedKeysInExpr,
                reason: 'strict_taint mode rejects conditions referencing tainted data',
              });
              return false;
            }
            logger.warn('tainted_condition_warning', {
              condition: condition.condition,
              tainted_keys: taintedKeysInExpr,
              hint: 'Condition references tainted memory keys — result may be influenced by untrusted data',
            });
          }
        }

        const fn = getCompiledExpression(expression);
        // Expose taint as first-class, top-level routing inputs so edges can gate
        // on untrusted data WITHOUT dot-accessing the internal `_taint_registry`:
        //   - `tainted`       → true when any memory key is tainted
        //   - `tainted_keys`  → the list of tainted keys (use with `includes(...)`)
        // This is what lets a graph route tainted flows through an approval gate.
        const result = fn({ ...state, tainted: taintedKeys.length > 0, tainted_keys: taintedKeys });

        // filtrex with useDotAccessOperatorAndOptionalChaining may return
        // an Error object (e.g. UnknownPropertyError) instead of throwing.
        if (result instanceof Error) {
          logger.warn('condition_evaluation_property_error', {
            condition: condition.condition,
            error: result.message,
          });
          return false;
        }

        return Boolean(result);
      } catch (error) {
        logger.error('condition_evaluation_error', error, { condition: condition.condition });
        return false;
      }
    }

    case 'map':
      if (!condition.condition) return true;
      return evaluateCondition(
        { type: 'conditional', condition: condition.condition, value: condition.value },
        state,
      );

    default:
      return false;
  }
}

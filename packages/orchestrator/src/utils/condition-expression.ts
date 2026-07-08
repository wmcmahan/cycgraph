/**
 * Condition Expression Options
 *
 * The filtrex compile options and expression normalization shared by the
 * runtime evaluator (`runner/conditions.ts`), the verifier executor's
 * `expression` variant, and the load-time graph validator. Living in
 * `utils/` keeps the dependency direction downward for all three —
 * `validation/` must not import from `runner/`.
 *
 * The validator and the evaluator MUST use identical options and
 * normalization so that `validateGraph()` rejects exactly the set of
 * expressions that `evaluateCondition()` cannot evaluate.
 *
 * @module utils/condition-expression
 */

import { useDotAccessOperatorAndOptionalChaining } from 'filtrex';

/** Extra functions available inside condition expressions. */
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

/** Shared filtrex compile options (dot access + the extra functions above). */
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

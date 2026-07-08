/**
 * Eval Assertion Checker
 *
 * Evaluates a single {@link EvalAssertion} against the final
 * {@link WorkflowState} produced by the eval runner.
 *
 * Assertion types:
 * - `status_equals` — workflow finished in the expected status
 * - `memory_contains` — a key exists in workflow memory
 * - `memory_matches` — a memory value matches (exact, contains, regex)
 * - `llm_judge` — an LLM evaluator scores the output above a threshold
 * - `node_visited` — a specific node was executed
 * - `token_budget_respected` — token usage stayed within budget
 *
 * @module evals/assertions
 */

import type { WorkflowState } from '../types/state.js';
import type { EvalAssertion, AssertionResult } from './types.js';
import { evaluateQualityExecutor } from '../agent/evaluator-executor/executor.js';

/**
 * Check a single assertion against the final workflow state.
 *
 * @param assertion - The assertion to evaluate.
 * @param finalState - The terminal workflow state.
 * @returns The assertion result indicating pass/fail with diagnostics.
 */
export async function checkAssertion(
  assertion: EvalAssertion,
  finalState: WorkflowState,
): Promise<AssertionResult> {
  switch (assertion.type) {

    case 'status_equals': {
      const passed = finalState.status === assertion.expected;
      return {
        assertion,
        passed,
        actual: finalState.status,
        message: passed
          ? undefined
          : `Expected status "${assertion.expected}", got "${finalState.status}"`,
      };
    }

    case 'memory_contains': {
      const passed = assertion.key in finalState.memory;
      return {
        assertion,
        passed,
        actual: Object.keys(finalState.memory),
        message: passed
          ? undefined
          : `Memory does not contain key "${assertion.key}"`,
      };
    }

    case 'memory_matches': {
      const value = finalState.memory[assertion.key];
      let passed = false;

      if (assertion.mode === 'exact') {
        passed = JSON.stringify(value) === JSON.stringify(assertion.expected);
      } else if (assertion.mode === 'contains') {
        passed = typeof value === 'string' && typeof assertion.expected === 'string'
          ? value.includes(assertion.expected)
          : JSON.stringify(value).includes(JSON.stringify(assertion.expected));
      } else if (assertion.mode === 'regex') {
        try {
          // Cap the matched input to bound ReDoS worst-case time (same
          // mitigation as the runtime verifier's safeRegexTest).
          passed = typeof value === 'string' && new RegExp(assertion.pattern).test(value.slice(0, 10_000));
        } catch {
          return {
            assertion,
            passed: false,
            actual: value,
            message: `Invalid regex pattern: "${assertion.pattern}"`,
          };
        }
      }

      return {
        assertion,
        passed,
        actual: value,
        message: passed ? undefined : `Memory key "${assertion.key}" did not match (mode: ${assertion.mode})`,
      };
    }

    case 'llm_judge': {
      try {
        const evalResult = await evaluateQualityExecutor(
          assertion.evaluator_agent_id,
          assertion.criteria,
          finalState.memory,
        );
        const passed = evalResult.score >= assertion.threshold;
        return {
          assertion,
          passed,
          actual: evalResult.score,
          message: passed
            ? undefined
            : `LLM judge score ${evalResult.score} below threshold ${assertion.threshold}: ${evalResult.reasoning}`,
        };
      } catch (error) {
        return {
          assertion,
          passed: false,
          message: `LLM judge error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case 'node_visited': {
      const passed = finalState.visited_nodes.includes(assertion.node_id);
      return {
        assertion,
        passed,
        actual: finalState.visited_nodes,
        message: passed
          ? undefined
          : `Node "${assertion.node_id}" was not visited. Visited: ${finalState.visited_nodes.join(', ')}`,
      };
    }

    case 'token_budget_respected': {
      const passed = !finalState.max_token_budget || finalState.total_tokens_used <= finalState.max_token_budget;
      return {
        assertion,
        passed,
        actual: { used: finalState.total_tokens_used, budget: finalState.max_token_budget },
        message: passed
          ? undefined
          : `Token budget exceeded: ${finalState.total_tokens_used}/${finalState.max_token_budget}`,
      };
    }

    default: {
      // Exhaustive check — TypeScript will error here if a new assertion type is added without handling
      const _exhaustive: never = assertion;
      return {
        assertion: _exhaustive,
        passed: false,
        message: `Unknown assertion type`,
      };
    }
  }
}

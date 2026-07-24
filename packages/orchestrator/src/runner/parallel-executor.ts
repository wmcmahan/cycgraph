/**
 * Parallel Executor
 *
 * Executes multiple graph node tasks concurrently with configurable
 * concurrency limits and error handling strategies.
 *
 * Uses `AbortController` for timeout-based cancellation so that
 * timed-out tasks are properly aborted rather than left running
 * in the background consuming resources.
 *
 * @module runner/parallel-executor
 */

import type { GraphNode } from '../types/graph.js';
import type { StateView, Action } from '../types/state.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.parallel');

/** A single unit of work for parallel execution. */
export interface ParallelTask {
  /** The node to execute. */
  node: GraphNode;
  /** Pre-built state view for this task. */
  stateView: StateView;
  /** Optional input item (used by map-reduce fan-out). */
  inputItem?: unknown;
  /** Optional index of the input item. */
  itemIndex?: number;
}

/** Result of a single parallel task execution. */
export interface ParallelResult {
  /** Index of this task in the original task array. */
  taskIndex: number;
  /** ID of the node that was executed. */
  nodeId: string;
  /** The action produced (undefined on failure). */
  action?: Action;
  /** Whether the task succeeded. */
  success: boolean;
  /** Error message on failure. */
  error?: string;
  /** Tokens consumed by this task. */
  tokensUsed?: number;
}

/** Configuration for parallel execution. */
export interface ParallelExecutionConfig {
  /** Maximum number of concurrent tasks per batch. */
  maxConcurrency: number;
  /** How to handle task failures. */
  errorStrategy: 'fail_fast' | 'best_effort';
  /** Per-task timeout in milliseconds. If a task exceeds this, it is aborted. */
  taskTimeoutMs?: number;
}

/**
 * Execute tasks in parallel with concurrency control.
 *
 * Worker-pool design (not fixed batches): at most `maxConcurrency` tasks
 * are in flight, and a new task starts as soon as any slot frees up — a
 * slow task delays only its own slot, not a whole batch. Results are
 * returned in task order regardless of completion order.
 *
 * Under `fail_fast`, the first failure stops the pool from claiming new
 * tasks; in-flight tasks settle, their results are kept, and the failure
 * is thrown. Under `best_effort`, every task runs and failures are
 * collected as unsuccessful results.
 *
 * When `taskTimeoutMs` is set, each task gets an `AbortController`
 * whose signal is aborted on timeout. The `executeFn` receives an
 * `AbortSignal` that it should propagate to LLM calls.
 *
 * @param tasks - The tasks to execute.
 * @param executeFn - Executor function called for each task. Receives an optional AbortSignal for cancellation.
 * @param config - Concurrency and error strategy configuration.
 * @returns Results for all executed tasks.
 */
export async function executeParallel(
  tasks: ParallelTask[],
  executeFn: (task: ParallelTask, signal?: AbortSignal) => Promise<Action>,
  config: ParallelExecutionConfig,
): Promise<ParallelResult[]> {
  // Sparse by index: under fail_fast, unclaimed tasks leave holes that are
  // compacted before returning (order is preserved via the index).
  const results: Array<ParallelResult | undefined> = new Array(tasks.length);
  let failure: Error | null = null;
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(config.maxConcurrency, tasks.length || 1));

  logger.info('parallel_execution_start', {
    total_tasks: tasks.length,
    max_concurrency: config.maxConcurrency,
    error_strategy: config.errorStrategy,
  });

  const runOne = async (taskIndex: number): Promise<void> => {
    const task = tasks[taskIndex];
    try {
      let action: Action;

      if (config.taskTimeoutMs) {
        // Create an AbortController for cooperative cancellation.
        // The signal is passed to executeFn so LLM calls can be aborted.
        // Promise.race ensures the timeout rejects immediately even if
        // executeFn doesn't check the signal (resource leak prevention).
        const abortController = new AbortController();
        const timeoutMs = config.taskTimeoutMs;

        action = await Promise.race([
          executeFn(task, abortController.signal),
          new Promise<never>((_, reject) => {
            const timeoutId = setTimeout(() => {
              abortController.abort(new Error(`Task ${taskIndex} (${task.node.id}) timed out after ${timeoutMs}ms`));
              reject(new Error(`Task ${taskIndex} (${task.node.id}) timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            // Clean up timer if the task completes or the signal is aborted first
            abortController.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });
          }),
        ]);

        // Task completed before timeout — abort to clean up the timer
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      } else {
        action = await executeFn(task);
      }

      const extMetadata = action.metadata as Record<string, unknown>;
      const tokenUsage = extMetadata?.token_usage as { totalTokens?: number } | undefined;

      results[taskIndex] = {
        taskIndex,
        nodeId: task.node.id,
        action,
        success: true,
        tokensUsed: tokenUsage?.totalTokens,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn('parallel_task_failed', { task_index: taskIndex, node_id: task.node.id, error: errorMsg });

      results[taskIndex] = {
        taskIndex,
        nodeId: task.node.id,
        success: false,
        error: errorMsg,
      };

      if (config.errorStrategy === 'fail_fast' && !failure) {
        failure = new Error(`Task ${taskIndex} (${task.node.id}) failed: ${errorMsg}`);
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      // fail_fast: stop claiming new tasks once a failure is recorded.
      if (failure) return;
      const current = nextIndex++;
      if (current >= tasks.length) return;
      await runOne(current);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));

  const compacted = results.filter((r): r is ParallelResult => r !== undefined);
  logger.info('parallel_execution_complete', {
    total: compacted.length,
    successful: compacted.filter(r => r.success).length,
    failed: compacted.filter(r => !r.success).length,
  });

  if (failure) throw failure;
  return compacted;
}

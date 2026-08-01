/**
 * Shared test helpers for the context-engine suites.
 */

import type { PromptSegment, SegmentRole, StageContext, BudgetConfig } from '../src/pipeline/types.js';
import type { TokenCounter } from '../src/providers/types.js';

export const wordTokenCounter: TokenCounter = {
  countTokens: (text: string) => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length),
};

export function seg(
  id: string,
  content: string,
  role: SegmentRole = 'memory',
  opts?: Partial<PromptSegment>,
): PromptSegment {
  return { id, content, role, priority: 1, locked: false, ...opts };
}

export function makeContext(opts?: {
  maxTokens?: number;
  outputReserve?: number;
  segmentBudgets?: Record<string, number>;
  tokenCounter?: TokenCounter;
  model?: string;
  query?: string;
  debug?: boolean;
  logger?: StageContext['logger'];
}): StageContext {
  const budget: BudgetConfig = {
    maxTokens: opts?.maxTokens ?? 4096,
    outputReserve: opts?.outputReserve ?? 0,
    ...(opts?.segmentBudgets ? { segmentBudgets: opts.segmentBudgets } : {}),
  };
  return {
    tokenCounter: opts?.tokenCounter ?? wordTokenCounter,
    budget,
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    ...(opts?.query !== undefined ? { query: opts.query } : {}),
    ...(opts?.debug !== undefined ? { debug: opts.debug } : {}),
    ...(opts?.logger !== undefined ? { logger: opts.logger } : {}),
  };
}

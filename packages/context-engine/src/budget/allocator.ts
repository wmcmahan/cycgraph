/**
 * Budget Allocator
 *
 * Distributes a token budget across prompt segments based on priority
 * weighting. Locked segments get their exact allocation (non-negotiable).
 * Remaining budget is distributed by priority weight with surplus
 * redistribution.
 *
 * @module budget/allocator
 */

import type { TokenCounter } from '../providers/types.js';
import type { CompressionStage, PromptSegment, BudgetConfig, StageContext } from '../pipeline/types.js';
import { countSegmentTokens } from './counter.js';

export interface AllocatorStageOptions {
  /** Custom suffix appended to truncated segments (default: '\n... [truncated]'). */
  truncationSuffix?: string;
}

export interface AllocationResult {
  /** Allocated tokens per segment (segment ID → token budget). */
  allocations: Map<string, number>;
  /** Segment IDs that exceed their allocation after truncation. */
  overflow: string[];
}

/**
 * Allocate token budget across segments.
 *
 * Algorithm:
 * 1. Subtract outputReserve from total budget
 * 2. Locked segments get their exact token count (non-negotiable)
 * 3. Remaining budget distributed to mutable segments by priority weight
 * 4. Segments under budget donate surplus for redistribution
 */
export function allocateBudget(
  segments: PromptSegment[],
  budget: BudgetConfig,
  counter: TokenCounter,
  model?: string,
): AllocationResult {
  const counts = countSegmentTokens(segments, counter, model);
  const availableBudget = budget.maxTokens - (budget.outputReserve ?? 0);
  const allocations = new Map<string, number>();

  // 1. Locked segments: exact allocation
  let lockedTotal = 0;
  for (const seg of segments) {
    if (seg.locked) {
      const tokens = counts.get(seg.id) ?? 0;
      allocations.set(seg.id, tokens);
      lockedTotal += tokens;
    }
  }

  // 1b. Check if locked segments exceed available budget
  const overflow: string[] = [];
  if (lockedTotal > availableBudget) {
    for (const seg of segments) {
      if (seg.locked) overflow.push(seg.id);
    }
  }

  // 2. Mutable segments: distribute remaining by priority
  const mutableBudget = Math.max(0, availableBudget - lockedTotal);
  const mutableSegments = segments.filter(s => !s.locked);
  const totalPriority = mutableSegments.reduce((sum, s) => sum + (s.priority ?? 1), 0);

  if (totalPriority === 0 || mutableSegments.length === 0) {
    // No mutable segments or zero priority — nothing to allocate
    return { allocations, overflow: [] };
  }

  // First pass: proportional allocation with largest-remainder distribution
  const firstPass = new Map<string, number>();
  {
    const entries: { id: string; floor: number; remainder: number; cap: number }[] = [];
    let distributed = 0;
    for (const seg of mutableSegments) {
      const share = ((seg.priority ?? 1) / totalPriority) * mutableBudget;
      const actual = counts.get(seg.id) ?? 0;
      const floor = Math.min(Math.floor(share), actual);
      entries.push({ id: seg.id, floor, remainder: share - Math.floor(share), cap: actual });
      distributed += floor;
    }
    // Distribute remaining tokens by largest fractional remainder
    let remaining = mutableBudget - distributed;
    if (remaining > 0) {
      entries.sort((a, b) => b.remainder - a.remainder);
      for (const e of entries) {
        if (remaining <= 0) break;
        if (e.floor < e.cap) {
          e.floor++;
          remaining--;
        }
      }
    }
    for (const e of entries) {
      firstPass.set(e.id, e.floor);
    }
  }

  // Second pass: redistribute surplus from under-budget segments
  let surplus = 0;
  const needsMore: { id: string; want: number; have: number }[] = [];

  for (const seg of mutableSegments) {
    const allocated = firstPass.get(seg.id) ?? 0;
    const actual = counts.get(seg.id) ?? 0;

    if (allocated >= actual) {
      // Under budget: donate surplus
      surplus += allocated - actual;
      firstPass.set(seg.id, actual);
    } else if (actual > allocated) {
      needsMore.push({ id: seg.id, want: actual - allocated, have: allocated });
    }
  }

  // Distribute surplus proportionally to segments that need more
  // Uses largest-remainder method to avoid losing fractional tokens
  if (surplus > 0 && needsMore.length > 0) {
    const totalWant = needsMore.reduce((sum, n) => sum + n.want, 0);

    // First: distribute floor amounts and track remainders
    const bonuses: { idx: number; floor: number; remainder: number; cap: number }[] = [];
    let distributed = 0;
    for (let i = 0; i < needsMore.length; i++) {
      const need = needsMore[i];
      const exact = (need.want / totalWant) * surplus;
      const floor = Math.min(Math.floor(exact), need.want);
      bonuses.push({ idx: i, floor, remainder: exact - floor, cap: need.want });
      distributed += floor;
    }

    // Second: distribute remaining tokens one-at-a-time by largest remainder
    let remaining = surplus - distributed;
    if (remaining > 0) {
      bonuses.sort((a, b) => b.remainder - a.remainder);
      for (const b of bonuses) {
        if (remaining <= 0) break;
        if (b.floor < b.cap) {
          b.floor++;
          remaining--;
        }
      }
    }

    for (const b of bonuses) {
      const need = needsMore[b.idx];
      firstPass.set(need.id, need.have + b.floor);
    }
  }

  // Finalize allocations
  for (const seg of mutableSegments) {
    const allocated = firstPass.get(seg.id) ?? 0;
    const actual = counts.get(seg.id) ?? 0;
    allocations.set(seg.id, allocated);
    if (actual > allocated) {
      overflow.push(seg.id);
    }
  }

  return { allocations, overflow };
}

/**
 * Create a pipeline stage that enforces budget allocations by truncating
 * segments that exceed their allocation.
 */
export function createAllocatorStage(options?: AllocatorStageOptions): CompressionStage {
  const truncationSuffix = options?.truncationSuffix ?? '\n... [truncated]';
  return {
    name: 'budget-allocator',
    execute(segments: PromptSegment[], context: StageContext) {
      const { allocations } = allocateBudget(
        segments,
        context.budget,
        context.tokenCounter,
        context.model,
      );

      const output = segments.map(seg => {
        const budget = allocations.get(seg.id);
        if (budget === undefined) return seg;

        const currentTokens = context.tokenCounter.countTokens(seg.content, context.model);
        if (currentTokens <= budget) return seg;

        // Truncate to fit budget
        const truncated = truncateToTokens(seg.content, budget, context.tokenCounter, context.model, truncationSuffix);
        return { ...seg, content: truncated };
      });

      return { segments: output };
    },
  };
}

/**
 * Truncate text to fit within a token budget.
 * Uses binary search on character position for efficiency.
 */
function truncateToTokens(
  text: string,
  maxTokens: number,
  counter: TokenCounter,
  model: string | undefined,
  truncationSuffix: string,
): string {
  if (maxTokens <= 0) return '';

  // No truncation needed — full text fits within budget
  if (counter.countTokens(text, model) <= maxTokens) return text;

  // Reserve tokens for the suffix so the final output stays within budget
  const suffixTokens = counter.countTokens(truncationSuffix, model);
  const searchBudget = maxTokens - suffixTokens;
  if (searchBudget <= 0) return '';

  // Binary search for the right character cutoff
  let low = 0;
  let high = text.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const tokens = counter.countTokens(text.slice(0, mid), model);

    if (tokens <= searchBudget) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Never cut between a UTF-16 surrogate pair: if the last kept code unit is a
  // high surrogate, its low-surrogate partner was excluded, leaving a lone
  // surrogate that serializes to invalid UTF-8 (U+FFFD) at the provider. Drop it.
  if (best > 0 && best < text.length) {
    const lastUnit = text.charCodeAt(best - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) best -= 1;
  }

  return text.slice(0, best) + truncationSuffix;
}

/**
 * Chain-of-Thought Distillation
 *
 * Detects and evicts reasoning traces from System-2 model outputs.
 * Extracts conclusions from `<think>`, `<reasoning>`, `<scratchpad>`,
 * and similar delimiter blocks. Preserves the conclusion while
 * removing the verbose reasoning trace that dominates agentic context.
 *
 * @module pruning/cot-distillation
 */

import type { CompressionStage, PromptSegment, StageContext } from '../pipeline/types.js';

// ─── Delimiter Registry ───────────────────────────────────────────

/** A reasoning trace delimiter pair with its model family. */
export interface ReasoningDelimiter {
  open: string;
  close: string;
  family: string;
}

/** Default delimiter registry covering major model families. */
export const DEFAULT_DELIMITERS: readonly ReasoningDelimiter[] = [
  { open: '<think>', close: '</think>', family: 'deepseek' },
  { open: '<reasoning>', close: '</reasoning>', family: 'generic' },
  { open: '<scratchpad>', close: '</scratchpad>', family: 'generic' },
  { open: '<antThinking>', close: '</antThinking>', family: 'anthropic' },
  { open: '<thought>', close: '</thought>', family: 'openai' },
];

/** Model string → family mapping. */
function resolveModelFamily(model?: string): string | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  if (lower.startsWith('deepseek')) return 'deepseek';
  if (lower.startsWith('claude')) return 'anthropic';
  if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai';
  return undefined;
}

// ─── Conclusion Extraction ────────────────────────────────────────

const CONCLUSION_MARKERS = [
  'therefore:',
  'in conclusion:',
  'the answer is:',
  'so:',
  'thus:',
  'to summarize:',
  'in summary:',
  'the result is:',
  'final answer:',
];

/**
 * Extract the conclusion from a reasoning block.
 * Looks for conclusion markers, or takes the last paragraph.
 */
function extractConclusion(block: string): string | null {
  const lower = block.toLowerCase();

  // Try each conclusion marker
  for (const marker of CONCLUSION_MARKERS) {
    const idx = lower.lastIndexOf(marker);
    if (idx !== -1) {
      const rest = block.slice(idx + marker.length).trim();
      if (rest.length > 0) return rest;
    }
  }

  // Fall back to last non-empty paragraph
  const paragraphs = block.split('\n\n').map(p => p.trim()).filter(p => p.length > 0);
  if (paragraphs.length > 1) {
    return paragraphs[paragraphs.length - 1];
  }

  // Single paragraph with multiple sentences — take last sentence
  const sentences = block.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
  if (sentences.length > 1) {
    return sentences[sentences.length - 1].trim();
  }

  return null;
}

// ─── Core Distillation ────────────────────────────────────────────

export interface CotDistillationOptions {
  /** Custom delimiters to use instead of defaults. */
  delimiters?: ReasoningDelimiter[];
  /** Whether to extract and preserve conclusions (default true). */
  preserveConclusion?: boolean;
  /** Characters per token ratio for token eviction estimates (default 4). */
  charsPerToken?: number;
}

export interface CotDistillationResult {
  /** Content with reasoning traces replaced. */
  distilled: string;
  /** Number of reasoning blocks removed. */
  tracesRemoved: number;
  /** Estimated tokens evicted. */
  tokensEvicted: number;
}

/**
 * Distill reasoning traces from content, preserving conclusions.
 *
 * @param content - The text to distill.
 * @param options - Configuration options.
 * @param model - Target model string for family-aware delimiter selection.
 * @returns Distilled content with metrics.
 */
export function distillCoT(
  content: string,
  options?: CotDistillationOptions,
  model?: string,
): CotDistillationResult {
  const delimiters = options?.delimiters ?? [...DEFAULT_DELIMITERS];
  const preserveConclusion = options?.preserveConclusion ?? true;

  // Filter delimiters by model family
  const family = resolveModelFamily(model);
  const activeDelimiters = family
    ? delimiters.filter(d => d.family === family || d.family === 'generic')
    : delimiters;

  let result = content;
  let tracesRemoved = 0;
  let charsEvicted = 0;

  for (const delimiter of activeDelimiters) {
    let searchFrom = 0;

    while (true) {
      const openIdx = result.indexOf(delimiter.open, searchFrom);
      if (openIdx === -1) break;

      const closeIdx = result.indexOf(delimiter.close, openIdx + delimiter.open.length);
      if (closeIdx === -1) {
        // Unclosed delimiter — skip, don't corrupt content
        searchFrom = openIdx + delimiter.open.length;
        continue;
      }

      const blockStart = openIdx;
      const blockEnd = closeIdx + delimiter.close.length;
      const blockContent = result.slice(openIdx + delimiter.open.length, closeIdx).trim();
      const blockLength = blockEnd - blockStart;

      let replacement: string;
      if (preserveConclusion) {
        const conclusion = extractConclusion(blockContent);
        replacement = conclusion
          ? `[Reasoning distilled] ${conclusion}`
          : '[Reasoning trace removed]';
      } else {
        replacement = '[Reasoning trace removed]';
      }

      result = result.slice(0, blockStart) + replacement + result.slice(blockEnd);
      charsEvicted += blockLength - replacement.length;
      tracesRemoved++;

      // Continue searching after the replacement
      searchFrom = blockStart + replacement.length;
    }
  }

  // Rough token estimate
  const charsPerToken = options?.charsPerToken ?? 4;
  const tokensEvicted = Math.floor(charsEvicted / charsPerToken);

  return { distilled: result, tracesRemoved, tokensEvicted };
}

/**
 * Create a pipeline stage that distills reasoning traces.
 */
export function createCotDistillationStage(options?: CotDistillationOptions): CompressionStage {
  return {
    name: 'cot-distillation',
    // Each segment is transformed independently — safe for per-segment caching.
    scope: 'per-segment' as const,
    execute(segments: PromptSegment[], context: StageContext) {
      return {
        segments: segments.map(seg => {
          const result = distillCoT(seg.content, options, context.model);
          if (result.tracesRemoved === 0) return seg;
          return { ...seg, content: result.distilled };
        }),
      };
    },
  };
}

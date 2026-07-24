/**
 * Anthropic Provider
 *
 * Claude provider wrapping the official `@anthropic-ai/sdk` as an
 * {@link EvalProvider}. Used as the default reader model for the
 * compression benchmark, and available as a judge anywhere `callJudge`
 * is consumed.
 *
 * The default model is a PINNED dated ID (not a floating alias) so
 * benchmark results stay reproducible — a reader that silently upgrades
 * between runs invalidates cross-run comparisons.
 *
 * @module providers/anthropic
 */

import Anthropic from '@anthropic-ai/sdk';
import type { EvalProvider, CostEstimate, CallJudgeOptions } from './types.js';

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/**
 * Pinned reader model. Haiku tier: readers answer short QA spans and
 * judges emit small JSON objects — fast/cheap is the right fit, and the
 * dated suffix keeps published numbers reproducible.
 */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** Approximate cost per 1K tokens for Haiku 4.5 ($1/M input, $5/M output — blended). */
const HAIKU_COST_PER_1K_TOKENS = 0.002;

/** Estimated tokens per eval test case (prompt + response). */
const ESTIMATED_TOKENS_PER_TEST = 2000;

/** Options for creating the Anthropic provider. */
export interface AnthropicProviderOptions {
  /** Anthropic API key (default: ANTHROPIC_API_KEY env). */
  apiKey?: string;

  /** Model to use (default: pinned Haiku 4.5). */
  model?: string;

  /** Max concurrent evaluations (default: 8). */
  maxConcurrency?: number;

  /** Cost warning threshold in USD (default: 5.0). */
  costWarningThreshold?: number;
}

/**
 * Creates an Anthropic (Claude) eval provider.
 *
 * @throws If ANTHROPIC_API_KEY is not set and no apiKey is provided.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): EvalProvider {
  const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  const model = options.model ?? DEFAULT_MODEL;
  const maxConcurrency = options.maxConcurrency ?? 8;
  const costWarningThreshold = options.costWarningThreshold ?? 5.0;

  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required for the Claude provider.',
    );
  }

  const client = new Anthropic({
    apiKey,
    // Route through globalThis.fetch so the shared provider test pattern
    // (stubbing globalThis.fetch) applies to this provider too.
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  });

  return {
    name: `anthropic-${model}`,
    mode: 'ci',
    maxConcurrency,

    async callJudge(prompt: string, callOptions: CallJudgeOptions = {}): Promise<string> {
      const timeoutMs = callOptions.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;

      try {
        const response = await client.messages.create(
          {
            model,
            // Judge prompts ask for a short JSON object and reader prompts
            // ask for a short answer span; cap output to keep cost
            // predictable even when the model rambles.
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
          },
          { timeout: timeoutMs },
        );

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map(block => block.text)
          .join('');

        if (text.length === 0) {
          throw new Error(
            `Anthropic callJudge: response contained no text blocks (stop_reason: ${response.stop_reason})`,
          );
        }
        return text;
      } catch (err) {
        // Wrap SDK errors with the provider name so failures are attributable
        // in mixed-provider runs; keep the actionable detail.
        if (err instanceof Anthropic.APIConnectionTimeoutError) {
          throw new Error(`Anthropic callJudge timed out after ${timeoutMs}ms`);
        }
        if (err instanceof Anthropic.APIError) {
          throw new Error(
            `Anthropic callJudge failed: HTTP ${err.status ?? '?'} ${err.name} — ${err.message.slice(0, 200)}`,
          );
        }
        throw err;
      }
    },

    estimateCost(testCount: number): CostEstimate {
      const estimatedTokens = testCount * ESTIMATED_TOKENS_PER_TEST;
      const estimatedUsd = (estimatedTokens / 1000) * HAIKU_COST_PER_1K_TOKENS;

      const warning = estimatedUsd > costWarningThreshold
        ? `Estimated cost $${estimatedUsd.toFixed(2)} exceeds warning threshold of $${costWarningThreshold.toFixed(2)}`
        : undefined;

      return { estimatedUsd, warning };
    },
  };
}

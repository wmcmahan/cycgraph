/**
 * Model Capability Profiles
 *
 * Static capability matrix per model family. Used by the format
 * selector to choose the optimal compression format for each model.
 *
 * @module routing/model-profiles
 */

/** Capability profile for a model family. */
export interface ModelProfile {
  /** Model family name (matched via prefix). */
  family: string;
  /** Can the model comprehend TOON/tabular input format? */
  supportsTabular: boolean;
  /** Does the model work better with JSON for structured data? */
  prefersJson: boolean;
  /** Maximum context window size in tokens (pipeline warns when the budget exceeds it). */
  maxContextTokens: number;
  /** Does the model support native prompt caching? (consulted by `applyCachePolicy`) */
  supportsCaching: boolean;
}

/**
 * Built-in model profiles.
 *
 * Based on TOON benchmark data (arxiv 2601.12014) and provider docs.
 * Character-to-token ratios live in providers/defaults.ts (MODEL_FAMILY_RATIOS).
 */
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  'gpt-4o': {
    family: 'gpt-4o',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: true,
  },
  'gpt-4': {
    family: 'gpt-4',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: true,
  },
  'o1': {
    family: 'o1',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 200_000,
    supportsCaching: true,
  },
  'o3': {
    family: 'o3',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 200_000,
    supportsCaching: true,
  },
  'claude': {
    family: 'claude',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 200_000,
    supportsCaching: true,
  },
  'llama': {
    family: 'llama',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
  },
  'deepseek': {
    family: 'deepseek',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
  },
  'qwen': {
    family: 'qwen',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
  },
  'gemini': {
    family: 'gemini',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 1_000_000,
    supportsCaching: true,
  },
  'mistral': {
    family: 'mistral',
    supportsTabular: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
  },
  // Small models that need JSON
  'gemma': {
    family: 'gemma',
    supportsTabular: false,
    prefersJson: true,
    maxContextTokens: 8_192,
    supportsCaching: false,
  },
  'phi': {
    family: 'phi',
    supportsTabular: false,
    prefersJson: true,
    maxContextTokens: 16_384,
    supportsCaching: false,
  },
};

/**
 * Resolve the model profile for a given model string.
 * Matches against known family prefixes (case-insensitive).
 * Returns undefined if no profile matches.
 */
export function resolveModelProfile(model?: string): ModelProfile | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  for (const [prefix, profile] of Object.entries(MODEL_PROFILES)) {
    if (lower.startsWith(prefix)) return profile;
  }
  return undefined;
}

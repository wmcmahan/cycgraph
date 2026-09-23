/**
 * Agent System Constants
 *
 * Domain constants for the agent subsystem (model identifiers, default prompt
 * text, etc.) live here. Operational tuning knobs (timeouts, cache sizes, byte
 * caps) live in `runtime-config.ts` and are re-exported below for backwards
 * compatibility.
 *
 * @module agents/constants
 */

export {
  AGENT_CONFIG_CACHE_TTL_MS,
  MAX_AGENT_CONFIG_CACHE_SIZE,
  FALLBACK_CONFIG_CACHE_TTL_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_MEMORY_PROMPT_BYTES,
  MAX_MEMORY_VALUE_BYTES,
} from '../runtime-config.js';

// ─── Default Agent Config ───────────────────────────────────────────────

/** Default LLM model identifier when none is specified. */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5';

/** Default LLM provider. */
export const DEFAULT_AGENT_PROVIDER = 'anthropic';

/** Default sampling temperature (0 = deterministic, 1 = creative). */
export const DEFAULT_AGENT_TEMPERATURE = 0.7;

/** Default maximum tool-call steps. */
export const DEFAULT_AGENT_MAX_STEPS = 10;

/** Default system prompt for agents without a configured prompt. */
export const DEFAULT_AGENT_SYSTEM_PROMPT =
  'You are a helpful AI assistant working in an orchestrated workflow. Execute your task and provide your response.';

// ─── Known Models ───────────────────────────────────────────────────────

/** Known OpenAI model identifiers for provider inference and validation. */
export const OPENAI_MODELS = [
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4',
  'o1-preview', 'o1-mini', 'o3', 'o3-mini', 'o4-mini',
];

/** Known Anthropic model identifiers for provider inference and validation. */
export const ANTHROPIC_MODELS = [
  'claude-fable-5-1', 'claude-opus-5-5',
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  // Deprecated by Anthropic (retire 2026-06-15) — kept so existing configs still validate
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
];

/** Known Google Gemini model identifiers for provider inference and validation. */
export const GOOGLE_MODELS = [
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash',
  'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-2.5-flash-lite',
];

/** Known Groq-hosted model identifiers for provider inference and validation. */
export const GROQ_MODELS = [
  'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
  'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
];

/** Known DeepSeek API model identifiers for provider inference and validation. */
export const DEEPSEEK_API_MODELS = [
  'deepseek-v4-pro', 'deepseek-flash',
];

/** Known xAI model identifiers for provider inference and validation. */
export const XAI_MODELS = [
  'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1',
];

/**
 * Known Mistral API model identifiers for provider inference and validation.
 * The `-latest` aliases track the newest version of each line; dated
 * snapshots (e.g. `mistral-medium-2604`) pass through as unknown models.
 */
export const MISTRAL_MODELS = [
  'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest',
  'codestral-latest', 'ministral-8b-latest', 'ministral-3b-latest',
];

/** Known Cerebras-hosted model identifiers for provider inference and validation. */
export const CEREBRAS_MODELS = [
  'gpt-oss-120b', 'qwen-3.8-27b',
];

/** Known Ollama model identifiers for provider inference and validation. */
export const OLLAMA_MODELS = [
  // Tool-calling capable
  'llama3.1', 'llama3.1:8b', 'llama3.1:70b',
  'llama3.2', 'llama3.2:1b', 'llama3.2:3b',
  'llama3.3', 'llama3.3:70b',
  'qwen2.5', 'qwen2.5:7b', 'qwen2.5:32b', 'qwen2.5:72b',
  'mistral', 'mistral:7b',
  'mixtral', 'mixtral:8x7b',
  'command-r', 'hermes3',
  // Text-output only (no tool calling)
  'gemma2', 'gemma2:9b', 'gemma2:27b',
  'gemma3', 'gemma3:12b', 'gemma3:27b',
  'phi3', 'phi3:14b',
  'deepseek-r1', 'deepseek-r1:8b', 'deepseek-r1:32b',
];

export const PROVIDERS_MODELS = {
  'openai': OPENAI_MODELS,
  'anthropic': ANTHROPIC_MODELS,
  'ollama': OLLAMA_MODELS,
  'google': GOOGLE_MODELS,
  'groq': GROQ_MODELS,
  'deepseek': DEEPSEEK_API_MODELS,
  'xai': XAI_MODELS,
  'mistral': MISTRAL_MODELS,
  'cerebras': CEREBRAS_MODELS,
} as const;


/**
 * Agent System Constants
 *
 * Domain constants for the agent subsystem (model identifiers, default prompt
 * text, etc.) live here. Operational tuning knobs (timeouts, cache sizes, byte
 * caps) live in `runtime-config.ts` and are re-exported below for backwards
 * compatibility.
 *
 * @module agent/constants
 */

// ─── Operational knobs (re-exported from runtime-config) ────────────────

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
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-6';

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
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4',
  'o1-preview', 'o1-mini', 'o3', 'o3-mini', 'o4-mini',
];

/** Known Anthropic model identifiers for provider inference and validation. */
export const ANTHROPIC_MODELS = [
  'claude-opus-4-8', 'claude-sonnet-4-6',
  // Deprecated by Anthropic (retire 2026-06-15) — kept so existing configs still validate
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
];

/**
 * Known Ollama model identifiers for provider inference and validation.
 *
 * All popular Ollama models are listed here. Models with tool-calling
 * support (marked with ✓) can use `save_to_memory` and MCP tools.
 * Models without tool support work via orchestrator-managed text output.
 *
 * Tool-calling support: Llama 3.x ✓, Qwen 2.5 ✓, Mistral v0.3+ ✓,
 * Mixtral ✓, Command-R ✓, Hermes 3 ✓.
 * Text-output only: Gemma, Phi, DeepSeek-R1.
 */
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
} as const;


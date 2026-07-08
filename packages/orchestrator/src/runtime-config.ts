/**
 * Runtime Configuration
 *
 * Single source of truth for operational tuning knobs across the orchestrator
 * package: cache sizes, byte caps, ring-buffer bounds, and timeouts. All values
 * are env-overridable and Zod-validated at load time so misconfigurations fail
 * fast with a descriptive error rather than silently producing a 0-sized cache
 * or a negative timeout.
 *
 * Domain constants (model identifiers, default prompts, etc.) live in
 * `agent/constants.ts` — they aren't tunable at runtime and don't belong here.
 *
 * @module runtime-config
 */

import { z } from 'zod';

/**
 * Parse an integer from an environment variable. Returns `undefined` when the
 * variable is unset or empty so the Zod default can kick in.
 */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Zod schema with bounds for every operational knob. Bounds exist to catch
 * footguns (e.g. `MAX_MEMORY_VALUE_BYTES=0` would silently drop every update).
 * If you genuinely need a value outside these bounds, change the schema —
 * don't widen at the caller.
 */
const RuntimeConfigSchema = z.object({
  // ── Agent factory cache ──────────────────────────────────────────
  /** TTL for cached agent configs (ms). */
  AGENT_CONFIG_CACHE_TTL_MS: z.number().int().min(1_000).max(60 * 60 * 1000).default(5 * 60 * 1000),
  /** Max cached agent configs. */
  MAX_AGENT_CONFIG_CACHE_SIZE: z.number().int().min(1).max(10_000).default(100),
  /** Shorter TTL for fallback configs so DB recovery is detected sooner (ms). */
  FALLBACK_CONFIG_CACHE_TTL_MS: z.number().int().min(1_000).max(60 * 60 * 1000).default(30 * 1000),

  // ── Agent executor ───────────────────────────────────────────────
  /** Timeout for a single agent LLM invocation (ms). */
  DEFAULT_AGENT_TIMEOUT_MS: z.number().int().min(1_000).max(60 * 60 * 1000).default(2 * 60 * 1000),
  /** Max serialized memory bytes injected into the system prompt. */
  MAX_MEMORY_PROMPT_BYTES: z.number().int().min(1_024).max(10 * 1024 * 1024).default(50 * 1024),
  /** Max serialized bytes for a single memory value (rejected by reducers above this). */
  MAX_MEMORY_VALUE_BYTES: z.number().int().min(1_024).max(100 * 1024 * 1024).default(1024 * 1024),

  // ── State bounds ─────────────────────────────────────────────────
  /** Ring-buffer cap on `state.visited_nodes`. */
  MAX_VISITED_NODES: z.number().int().min(10).max(1_000_000).default(1000),
  /** Ring-buffer cap on `state.supervisor_history`. */
  MAX_SUPERVISOR_HISTORY: z.number().int().min(10).max(100_000).default(100),
  /** Ring-buffer cap on `state.memory_drops`. */
  MAX_MEMORY_DROPS: z.number().int().min(1).max(10_000).default(50),

  // ── Routing ──────────────────────────────────────────────────────
  /** LRU cap on the filtrex expression compile cache. */
  FILTREX_CACHE_SIZE: z.number().int().min(8).max(100_000).default(256),
});

/** The validated runtime config shape. */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Read env overrides and validate them against {@link RuntimeConfigSchema}.
 *
 * Invoked once at module load. Errors throw with a descriptive message so a
 * misconfigured deploy crashes early instead of running with broken caps.
 */
function loadRuntimeConfig(): RuntimeConfig {
  const overrides: Record<string, number | undefined> = {
    AGENT_CONFIG_CACHE_TTL_MS: envInt('AGENT_CONFIG_CACHE_TTL_MS'),
    MAX_AGENT_CONFIG_CACHE_SIZE: envInt('MAX_AGENT_CONFIG_CACHE_SIZE'),
    FALLBACK_CONFIG_CACHE_TTL_MS: envInt('FALLBACK_CONFIG_CACHE_TTL_MS'),
    DEFAULT_AGENT_TIMEOUT_MS: envInt('AGENT_TIMEOUT_MS'),
    MAX_MEMORY_PROMPT_BYTES: envInt('MAX_MEMORY_PROMPT_BYTES'),
    MAX_MEMORY_VALUE_BYTES: envInt('MAX_MEMORY_VALUE_BYTES'),
    MAX_VISITED_NODES: envInt('MAX_VISITED_NODES'),
    MAX_SUPERVISOR_HISTORY: envInt('MAX_SUPERVISOR_HISTORY'),
    MAX_MEMORY_DROPS: envInt('MAX_MEMORY_DROPS'),
    FILTREX_CACHE_SIZE: envInt('FILTREX_CACHE_SIZE'),
  };
  const filtered = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));

  const parsed = RuntimeConfigSchema.safeParse(filtered);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid runtime configuration (check env vars):\n${issues}`);
  }
  return parsed.data;
}

/** Validated runtime config (resolved once at module load). */
export const runtimeConfig: RuntimeConfig = loadRuntimeConfig();

// ─── Named exports (backwards-compatible aliases) ────────────────────
//
// Prefer importing these from this module; `agent/constants.ts`,
// `reducers/index.ts`, and `runner/conditions.ts` re-export them for
// back-compat.

export const AGENT_CONFIG_CACHE_TTL_MS = runtimeConfig.AGENT_CONFIG_CACHE_TTL_MS;
export const MAX_AGENT_CONFIG_CACHE_SIZE = runtimeConfig.MAX_AGENT_CONFIG_CACHE_SIZE;
export const FALLBACK_CONFIG_CACHE_TTL_MS = runtimeConfig.FALLBACK_CONFIG_CACHE_TTL_MS;
export const DEFAULT_AGENT_TIMEOUT_MS = runtimeConfig.DEFAULT_AGENT_TIMEOUT_MS;
export const MAX_MEMORY_PROMPT_BYTES = runtimeConfig.MAX_MEMORY_PROMPT_BYTES;
export const MAX_MEMORY_VALUE_BYTES = runtimeConfig.MAX_MEMORY_VALUE_BYTES;
export const MAX_VISITED_NODES = runtimeConfig.MAX_VISITED_NODES;
export const MAX_SUPERVISOR_HISTORY = runtimeConfig.MAX_SUPERVISOR_HISTORY;
export const MAX_MEMORY_DROPS = runtimeConfig.MAX_MEMORY_DROPS;
export const FILTREX_CACHE_SIZE = runtimeConfig.FILTREX_CACHE_SIZE;

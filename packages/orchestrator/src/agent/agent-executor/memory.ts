/**
 * Memory Extraction
 *
 * Extracts memory updates from an agent's execution. The primary path
 * captures the agent's text response and routes it to the appropriate
 * write key. When the agent explicitly calls `save_to_memory` (opt-in),
 * those structured writes take priority over the text output.
 *
 * @module agent-executor/memory
 */

import { createLogger } from '../../utils/logger.js';
import { sanitizeString } from './sanitizers.js';

const logger = createLogger('agent.executor.memory');

/**
 * Extract memory updates from an agent's response and tool calls.
 *
 * Processing rules:
 * 1. If `save_to_memory` tool calls exist, extract structured writes from them.
 *    Keys prefixed with `_` are blocked (reserved for system use).
 *    Keys not in `allowedKeys` are silently dropped with a warning log.
 * 2. If no `save_to_memory` calls produced updates and the agent returned
 *    text, route the response to the appropriate write key using this
 *    resolution order:
 *    a. `fallbackKey` (derived from `${node_id}_output`) if in allowedKeys
 *    b. `defaultWriteKey` (from node config) if in allowedKeys
 *    c. The sole concrete write key (when there is exactly one)
 *    d. Drop with warning (ambiguous multi-key, fail closed)
 *
 * @param agentResponse - The raw text response from the agent.
 * @param toolCalls - All tool calls made across every step of the agent execution.
 * @param allowedKeys - The agent's configured `write_keys`.
 * @param fallbackKey - Key for storing the raw response when no memory
 *   updates were extracted (defaults to `'agent_response'`).
 * @param defaultWriteKey - Explicit default key from node config, used to
 *   resolve multi-key ambiguity without requiring tool calling.
 * @returns A record of memory key → value updates.
 */
export function extractMemoryUpdates(
  agentResponse: string,
  toolCalls: Array<{ toolCallId: string; toolName: string; args?: unknown; input?: unknown }>,
  allowedKeys: string[],
  fallbackKey: string = 'agent_response',
  defaultWriteKey?: string,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};

  // Extract from save_to_memory tool calls (opt-in structured writes)
  for (const toolCall of toolCalls) {
    if (toolCall.toolName === 'save_to_memory') {
      const args = (toolCall.input ?? toolCall.args ?? {}) as Record<string, unknown>;
      const key = args.key;
      const value = args.value;

      if (!key || typeof key !== 'string') {
        logger.warn('invalid_memory_key', { key, tool_call_id: toolCall.toolCallId });
        continue;
      }

      // Block internal key prefix to prevent permission bypass
      if (key.startsWith('_')) {
        logger.warn('blocked_internal_key_write', { key });
        continue;
      }

      // Validate Zero Trust permission
      if (allowedKeys.includes('*') || allowedKeys.includes(key)) {
        updates[key] = value;
      } else {
        logger.warn('unauthorized_key_write', { key, allowed: allowedKeys });
      }
    }
  }

  // Primary path: Route text output to the appropriate write key.
  // Tool calls take priority — this only runs when no save_to_memory
  // calls produced updates.
  if (Object.keys(updates).length === 0 && agentResponse.trim()) {
    let targetKey = fallbackKey;

    if (!allowedKeys.includes('*') && !allowedKeys.includes(fallbackKey)) {
      // fallbackKey not in write_keys — resolve via defaultWriteKey or single-key heuristic
      if (defaultWriteKey && (allowedKeys.includes(defaultWriteKey) || allowedKeys.includes('*'))) {
        targetKey = defaultWriteKey;
      } else {
        const concreteKeys = allowedKeys.filter((k) => k !== '*');
        if (concreteKeys.length === 1) {
          targetKey = concreteKeys[0];
        } else {
          logger.warn('fallback_key_not_in_write_keys', {
            fallbackKey,
            defaultWriteKey,
            allowedKeys,
            reason: 'ambiguous — agent has multiple write keys and no default_write_key configured',
          });
        }
      }
    }

    if (allowedKeys.includes('*') || allowedKeys.includes(targetKey)) {
      updates[targetKey] = sanitizeString(agentResponse);
    }
  }

  return updates;
}

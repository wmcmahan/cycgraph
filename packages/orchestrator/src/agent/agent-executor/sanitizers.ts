/**
 * Prompt Injection Sanitizers
 *
 * Guards against prompt injection when embedding untrusted data (workflow
 * memory, user input) into LLM system prompts. These are defence-in-depth
 * measures — the `<data>` boundary in the prompt template is the primary
 * barrier, and these sanitizers remove known injection vectors.
 *
 * @module agent-executor/sanitizers
 */

/** Maximum recursion depth for {@link sanitizeValue} to prevent stack overflow. */
const MAX_SANITIZE_DEPTH = 10;

/**
 * Sanitize a string to prevent prompt injection.
 *
 * Strips patterns that could escape data boundaries or override instructions:
 * - Markdown headers that could inject new prompt sections
 * - XML-style tags used as data boundaries (`<data>`, `<system>`, etc.)
 * - Common instruction-override phrases ("IGNORE PREVIOUS INSTRUCTIONS")
 * - Unicode control characters used to hide content
 *
 * @param input - The string to sanitize.
 * @returns The sanitized string, or empty string if input is falsy.
 */
export function sanitizeString(input: string): string {
  if (!input) return '';
  return (
    input
      // NFKC normalization — collapses Unicode homographs (e.g. Cyrillic lookalikes) to ASCII
      .normalize('NFKC')
      // Strip carriage returns
      .replace(/\r/g, '')
      // Normalize consecutive newlines (3+ → 2)
      .replace(/\n{3,}/g, '\n\n')
      // Strip directional override characters (LTR/RTL embedding, isolates)
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
      // Prevent markdown header injection — catch both mid-string and start-of-string
      .replace(/^## /gm, '### ')
      .replace(/^# /gm, '### ')
      // Strip all XML/HTML-style tags that could escape <data> boundaries
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g, '')
      // Strip common instruction-override phrases
      .replace(/IGNORE\s+(ALL\s+)?PREVIOUS\s+(INSTRUCTIONS?|PROMPTS?)/gi, '[filtered]')
      .replace(/DISREGARD\s+(ALL\s+)?PREVIOUS/gi, '[filtered]')
      // Strip unicode null and zero-width characters (used to hide injected text)
      .replace(/[\u0000\u200B\u200C\u200D\uFEFF]/g, '')
      // Detect base64-encoded injection attempts
      .replace(/[A-Za-z0-9+/=]{20,}/g, (match) => {
        try {
          const decoded = Buffer.from(match, 'base64').toString('utf-8');
          if (/IGNORE\s+(ALL\s+)?PREVIOUS/i.test(decoded) || /DISREGARD\s+(ALL\s+)?PREVIOUS/i.test(decoded)) {
            return '[filtered]';
          }
        } catch {
          /* not valid base64, pass through */
        }
        return match;
      })
      .trim()
  );
}

/**
 * Sanitize all values in a memory record for safe prompt embedding.
 *
 * Recursively walks objects and arrays, sanitizing every string value.
 *
 * @param memory - The memory record to sanitize.
 * @returns A new record with all string values sanitized.
 */
export function sanitizeForPrompt(memory: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(memory)) {
    // Internal bookkeeping keys (e.g. `_taint_registry`) are executor-only and
    // must never appear in the model context.
    if (key.startsWith('_')) continue;
    sanitized[sanitizeString(key)] = sanitizeValue(value);
  }
  return sanitized;
}

/**
 * Recursively sanitize a single value (string, object, or array).
 *
 * Includes a depth guard to prevent stack overflow on deeply nested or
 * circular-reference objects. Beyond {@link MAX_SANITIZE_DEPTH}, values
 * are returned as the literal string `'[depth limit]'`.
 *
 * @param value - The value to sanitize.
 * @param depth - Current recursion depth (internal use).
 * @returns The sanitized value.
 */
export function sanitizeValue(value: unknown, depth: number = 0): unknown {
  if (depth >= MAX_SANITIZE_DEPTH) {
    return '[depth limit]';
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitized[sanitizeString(k)] = sanitizeValue(v, depth + 1);
    }
    return sanitized;
  }
  return value;
}

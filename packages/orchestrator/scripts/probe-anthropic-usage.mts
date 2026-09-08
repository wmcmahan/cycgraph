/**
 * Ground-truth probe for Anthropic prompt caching, wire-level.
 *
 * Wraps fetch so every outgoing request reports how many cache_control
 * markers it actually carries, and every response reports the raw API
 * usage fields — separating "our markers never reach the wire" from
 * "the API ignores them" from "reporting drops them".
 *
 * Run from the repository root, key held in your own shell:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/orchestrator/scripts/probe-anthropic-usage.mts
 *   PROBE_MODEL=claude-opus-5 to mirror CI's model exactly.
 *
 * Costs a few thousand Haiku tokens (well under $0.10).
 */

import { streamText, tool, isStepCount } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { cachePrepareStep, billedTokenTotal } from '../dist/agents/executors/agent/executor.js';

let requestNumber = 0;
const probeFetch: typeof fetch = async (input, init) => {
  requestNumber += 1;
  const body = typeof init?.body === 'string' ? init.body : '';
  const markers = (body.match(/"cache_control"/g) ?? []).length;
  console.log(`request ${requestNumber}: ${Math.round(body.length / 1024)}KB body, cache_control markers: ${markers}`);
  return fetch(input, init);
};

const anthropic = createAnthropic({ fetch: probeFetch });
const model = anthropic(process.env['PROBE_MODEL'] ?? 'claude-haiku-4-5-20251001');

// Caching needs a >1024-token stable prefix; pad well past it.
// Past every model's minimum cacheable prompt length (haiku 4.5: 4096
// tokens) from step 0, so writes start immediately and later steps read.
const padding = 'The quick brown fox jumps over the lazy dog while auditing token accounting. '.repeat(320);
const system = `You are a lookup assistant. ${padding} Use the lookup tool exactly as asked.`;

const lookup = tool({
  description: 'Look up a record by id.',
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => `record ${id}: ` + `payload-${id} `.repeat(200),
});

const result = streamText({
  model,
  system,
  prompt: 'Call lookup for ids "a", then "b", then "c" (three separate calls), then reply DONE with one sentence.',
  tools: { lookup },
  stopWhen: isStepCount(6),
  prepareStep: cachePrepareStep as never,
});

for await (const _ of result.textStream) { /* drain */ }

const steps = (await result.steps) ?? [];
console.log('\n=== per-step SDK usage ===');
steps.forEach((step: { usage?: unknown }, index: number) => {
  console.log(`step ${index}:`, JSON.stringify(step.usage));
});

const total = await result.totalUsage;
console.log('\n=== totalUsage (raw) ===');
console.log(JSON.stringify(total, null, 2));
console.log('\nbilledTokenTotal:', billedTokenTotal(total as never));

console.log('\n=== how to read this ===');
console.log('markers 0 in requests 2+  -> our prepareStep marks are dropped before the wire (engine-side bug)');
console.log('markers >0, cache fields 0 in usage -> API accepted nothing (marker placement invalid)');
console.log('markers >0, cacheRead >0 on later steps -> caching works; earlier CI zeros were reporting-only');

// ── Phase B: raw, SDK-free canonical caching request, twice ──────────
// If this caches, the poison is in the SDK's request body; if it also
// reports zeros, caching is off at the API/account level.
console.log('\n=== phase B: raw canonical request (no SDK) ===');
const rawModel = process.env['PROBE_MODEL'] ?? 'claude-haiku-4-5-20251001';
const bigSystem = 'You are terse. ' + 'Context block for caching, stable across requests. '.repeat(700);
for (let attempt = 1; attempt <= 2; attempt++) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env['ANTHROPIC_API_KEY'] ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: rawModel,
      max_tokens: 16,
      system: [{ type: 'text', text: bigSystem, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Say OK.' }],
    }),
  });
  const json = await response.json() as { usage?: unknown; error?: unknown };
  console.log(`raw request ${attempt}:`, JSON.stringify(json.usage ?? json.error));
}
console.log('\nexpected if caching is available: request 1 cache_creation > 0, request 2 cache_read > 0');

/**
 * Model Pricing Drift Checker
 *
 * Compares the static MODEL_PRICING table (and the known-model lists) against
 * LiteLLM's community-maintained pricing table — the de-facto source of truth
 * for per-model costs across providers.
 *
 * Report-only by design: the engine's static table stays the reviewed,
 * offline default (pricing feeds budget enforcement, a security control, so
 * runtime network fetches are deliberately not built in). Run this at dev
 * time to find drift, then update `src/utils/pricing.ts` by hand. Hosts that
 * want live pricing load it themselves via `loadPricingTable()`.
 *
 * Usage:
 *   npm run check:pricing            # from packages/orchestrator
 *   npx tsx scripts/check-model-pricing.ts
 *
 * Env:
 *   PRICING_SOURCE_URL — override the upstream JSON URL.
 */

import { MODEL_PRICING } from '../src/utils/pricing.js';
import { PROVIDERS_MODELS } from '../src/agent/constants.js';

const PRIMARY_URL =
  process.env.PRICING_SOURCE_URL ??
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// GitHub contents API mirror of the same file (works where raw.* is blocked).
const FALLBACK_URL =
  'https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json';

/** Relative drift beyond which we flag a price as stale. */
const DRIFT_TOLERANCE = 0.005; // 0.5%

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  litellm_provider?: string;
  mode?: string;
}

async function fetchUpstream(): Promise<Record<string, LiteLLMEntry>> {
  for (const [url, init] of [
    [PRIMARY_URL, undefined],
    [FALLBACK_URL, { headers: { Accept: 'application/vnd.github.raw+json' } }],
  ] as Array<[string, RequestInit | undefined]>) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        console.error(`  fetch ${url} → HTTP ${res.status}`);
        continue;
      }
      return (await res.json()) as Record<string, LiteLLMEntry>;
    } catch (err) {
      console.error(`  fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error('Could not fetch the upstream pricing table from any source.');
}

/** LiteLLM keys models both bare ("gpt-4o") and provider-prefixed. */
function findUpstreamEntry(
  upstream: Record<string, LiteLLMEntry>,
  model: string,
): LiteLLMEntry | undefined {
  const candidates = [model, `anthropic/${model}`, `openai/${model}`, `ollama/${model}`];
  for (const key of candidates) {
    const entry = upstream[key];
    if (entry && (entry.input_cost_per_token !== undefined || entry.output_cost_per_token !== undefined)) {
      return entry;
    }
  }
  return undefined;
}

function perMToken(costPerToken: number | undefined): number | undefined {
  return costPerToken === undefined ? undefined : costPerToken * 1_000_000;
}

function drifted(ours: number, theirs: number): boolean {
  if (ours === theirs) return false;
  const base = Math.max(Math.abs(theirs), 1e-9);
  return Math.abs(ours - theirs) / base > DRIFT_TOLERANCE;
}

async function main(): Promise<void> {
  console.log('Fetching upstream pricing table (LiteLLM)…');
  const upstream = await fetchUpstream();
  console.log(`Upstream table loaded: ${Object.keys(upstream).length} models.\n`);

  let driftCount = 0;
  let missingUpstream = 0;

  console.log('── Price drift (static table vs upstream) ──');
  for (const [model, ours] of Object.entries(MODEL_PRICING)) {
    if (ours.inputPerMToken === 0 && ours.outputPerMToken === 0) continue; // local models
    const entry = findUpstreamEntry(upstream, model);
    if (!entry) {
      missingUpstream++;
      console.log(`  ? ${model}: not found upstream (verify manually)`);
      continue;
    }
    const upIn = perMToken(entry.input_cost_per_token);
    const upOut = perMToken(entry.output_cost_per_token);
    const inDrift = upIn !== undefined && drifted(ours.inputPerMToken, upIn);
    const outDrift = upOut !== undefined && drifted(ours.outputPerMToken, upOut);
    if (inDrift || outDrift) {
      driftCount++;
      console.log(
        `  ✗ ${model}: ours $${ours.inputPerMToken}/$${ours.outputPerMToken} per Mtok, ` +
        `upstream $${upIn?.toFixed(2)}/$${upOut?.toFixed(2)}`,
      );
    }
  }
  if (driftCount === 0) console.log('  ✓ no drift detected');

  console.log('\n── Known models with no pricing entry (bill as $0) ──');
  let unpriced = 0;
  for (const [provider, models] of Object.entries(PROVIDERS_MODELS)) {
    if (provider === 'ollama') continue; // local models are $0 by design
    for (const model of models) {
      if (!MODEL_PRICING[model]) {
        unpriced++;
        const entry = findUpstreamEntry(upstream, model);
        const hint = entry
          ? ` — upstream: $${perMToken(entry.input_cost_per_token)?.toFixed(2)}/$${perMToken(entry.output_cost_per_token)?.toFixed(2)} per Mtok`
          : '';
        console.log(`  ✗ ${provider}:${model}${hint}`);
      }
    }
  }
  if (unpriced === 0) console.log('  ✓ every known model is priced');

  console.log(
    `\nSummary: ${driftCount} drifted, ${unpriced} unpriced, ${missingUpstream} not found upstream.`,
  );
  if (driftCount > 0 || unpriced > 0) {
    console.log('Update src/utils/pricing.ts accordingly.');
    if (process.argv.includes('--strict')) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

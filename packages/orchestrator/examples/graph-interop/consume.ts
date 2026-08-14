/**
 * Graph Interop: consume (2 of 2) — compose with a graph you did not write.
 *
 * This file never imports publish.ts. It reads a JSON artifact, the same thing
 * an npm package or a registry would hand you, and composes with it.
 *
 * Run:  npx tsx examples/graph-interop/publish.ts   # writes the artifact
 *       CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/graph-interop/consume.ts
 * See:  ./README.md for the sequence a host should follow and what it defends against.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  agent,
  node,
  subgraph,
  graph,
  run,
  tool,
  parseBundle,
  checkRequirements,
  BundleIntegrityError,
  GraphSpecError,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

const BUNDLE_PATH = join(import.meta.dirname, 'market-analysis.bundle.json');

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const raw = await readFile(BUNDLE_PATH, 'utf8').catch(() => null);
if (raw === null) {
  console.error(`No artifact at ${BUNDLE_PATH}`);
  console.error('Publish it first:  npx tsx examples/graph-interop/publish.ts');
  process.exit(1);
}

// ─── 1. Validate the artifact ────────────────────────────────────────────

const block = parseBundle(JSON.parse(raw));
const { manifest } = block;

// A manifest that under-declares is either tampered or mis-assembled, and
// `parseBundle` refuses it. Here the requires block is emptied while the
// graph still calls the tool — the artifact no longer describes itself.
const tampered = JSON.parse(raw) as { manifest: { requires: { tools: unknown[] } } };
tampered.manifest.requires.tools = [];

try {
  parseBundle(tampered);
  console.log('✗ expected a BundleIntegrityError, got none\n');
} catch (error) {
  if (!(error instanceof BundleIntegrityError)) throw error;
  console.log('═══ Integrity check ═══\n');
  for (const violation of error.violations) console.log(`  ✓ rejected: ${violation}`);
  console.log('');
}

// ─── 2. Read the contract ────────────────────────────────────────────────

console.log(`═══ ${manifest.name}@${manifest.version} ═══\n`);
console.log(`  source:      ${manifest.source ?? '(unstated)'}`);
console.log(`  description: ${manifest.description ?? '(none)'}\n`);

console.log('  Interface');
for (const [key, decl] of Object.entries(manifest.inputs)) {
  console.log(`    in   ${(key + (decl.required ? '' : '?')).padEnd(9)} ${decl.description ?? ''}`);
}
for (const [key, decl] of Object.entries(manifest.outputs)) {
  console.log(`    out  ${key.padEnd(9)} ${decl.description ?? ''}`);
}

/** Compact `name: type, …` rendering of a tool's argument schema. */
function args(schema: Record<string, unknown> | undefined): string {
  const properties = (schema?.properties ?? {}) as Record<string, { type?: string }>;
  const entries = Object.entries(properties).map(([name, spec]) => `${name}: ${spec.type ?? 'any'}`);
  return entries.join(', ') || '(none)';
}

console.log('\n  Requires');
console.log(`    models: ${manifest.requires.models.join(', ') || '(none)'}`);
for (const required of manifest.requires.tools) {
  console.log(`    tool:   ${required.name}(${args(required.input_schema)})`);
}
console.log('');

// ─── 3. Preflight ────────────────────────────────────────────────────────

const bare = await checkRequirements(block, {});
console.log('═══ Requirements preflight ═══\n');
console.log(`  with nothing supplied — ok: ${bare.ok}, missing tools: ${bare.missingTools.join(', ')}`);

// The host's own implementation, bound to the name the manifest asked for.
// Its argument schema honors `requires.tools[].input_schema`.
const marketData = tool({
  name: 'fetch_market_data',
  description: 'Look up recent market data for a named sector from the internal warehouse.',
  parameters: z.object({
    sector: z.string(),
    year: z.number().int(),
  }),
  taints: true,
  execute: async ({ sector, year }) => ({
    sector,
    year,
    shipments_gwh: 412,
    avg_price_usd_per_kwh: 108,
    yoy_demand_change_pct: 31,
    source: 'acme-internal-warehouse',
  }),
});

const wired = await checkRequirements(block, { tools: [marketData] });
console.log(`  with fetch_market_data bound — ok: ${wired.ok}\n`);

// ─── 4. Compose ──────────────────────────────────────────────────────────
// The interface survived serialization, so a mis-wire against a bundle you
// downloaded fails at compile time just like a local child graph.

try {
  graph({
    name: 'mis-wired',
    nodes: [
      subgraph(block, {
        id: 'analyze-sector',
        reads: ['target_sector'],
        inputs: { target_sector: 'industry' },
        outputs: { analysis: 'sector_analysis' },
      }),
    ],
  });
  console.log('✗ expected a GraphSpecError, got none\n');
} catch (error) {
  if (!(error instanceof GraphSpecError)) throw error;
  console.log('═══ Mis-wire against the downloaded block ═══\n');
  console.log(`  ✓ ${error.message}\n`);
}

const memoNode = node({
  id: 'memo',
  agent: agent({
    model: MODEL,
    provider: PROVIDER,
    instructions:
      'Turn the sector analysis into a two-sentence investment memo: one sentence on the thesis, ' +
      'one on the risk.',
  }),
  reads: ['sector_analysis'],
  writes: 'memo',
});

const pipeline = graph({
  name: 'sector-memo',
  description: 'Wraps a third-party market-analysis block in an investment memo.',
  nodes: [
    subgraph(block, {
      id: 'analyze-sector',
      reads: ['target_sector', 'target_year'],
      inputs: { target_sector: 'sector', target_year: 'year' },
      outputs: { analysis: 'sector_analysis' },
      // The output mapping is the write grant — `sector_analysis` needs no
      // separate `writes` entry.
    }),
    memoNode,
  ],
  edges: [{ from: 'analyze-sector', to: memoNode }],
});

// The bundle's agents auto-register from the artifact. Only the tool
// implementation has to be handed to the runner — it is the one thing the
// manifest names but does not carry.
const result = await run(
  pipeline,
  {
    goal: 'Produce an investment memo on grid-scale storage.',
    memory: { target_sector: 'grid-scale storage', target_year: 2026 },
  },
  { runner: { providers: exampleProviders(), tools: [marketData] } },
);

console.log('═══ Sector analysis (from the third-party block) ═══\n' + (result.sector_analysis ?? '(none)'));
console.log('\n═══ Investment memo ═══\n' + (result.memo ?? '(none)'));

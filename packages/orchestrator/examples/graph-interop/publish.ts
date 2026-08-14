/**
 * Graph Interop: publish (1 of 2) — lift a composed graph into a portable
 * artifact. Implementations stay behind; the manifest names what a host must
 * supply.
 *
 * Run:  npx tsx examples/graph-interop/publish.ts
 * See:  ./README.md for what travels and what does not.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agent, node, graph, tool, bundle } from '@cycgraph/orchestrator';
import { MODEL, PROVIDER } from '../_model.js';

const BUNDLE_PATH = join(import.meta.dirname, 'market-analysis.bundle.json');

// ─── The publisher's own tool implementation ─────────────────────────────
// A development stub. It stays behind: the bundle records the NAME and the
// argument schema in `requires.tools`, and the consuming host supplies a
// real implementation under the same name.

const fetchMarketData = tool({
  name: 'fetch_market_data',
  description:
    'Look up recent market data for a named sector: shipment volume, average selling price, and demand trend.',
  parameters: z.object({
    sector: z.string().describe('Sector name, e.g. "grid-scale storage"'),
    year: z.number().int().describe('Calendar year to report on'),
  }),
  // External data: results land in the taint registry, and the taint crosses
  // the composition boundary back into the consumer's state.
  taints: true,
  execute: async ({ sector, year }) => ({
    sector,
    year,
    note: 'publisher development stub — the consuming host binds its own data source',
  }),
});

// ─── The block ───────────────────────────────────────────────────────────

const analyze = node({
  id: 'analyze',
  agent: agent({
    model: MODEL,
    provider: PROVIDER,
    instructions:
      'You are a market analyst. Call fetch_market_data for the sector under study, then write a ' +
      'short analysis covering the demand trend, the price trend, and the single biggest risk.',
    tools: [fetchMarketData],
  }),
  reads: ['sector', 'year'],
  writes: 'analysis',
});

const marketBlock = graph({
  name: 'market-analysis-block',
  description: 'Analyzes a market sector against recent data and returns a written analysis.',
  nodes: [analyze],
  inputs: {
    sector: { schema: z.string().min(2), description: 'The market sector to analyze' },
    year: {
      schema: z.number().int().min(2000).max(2100).default(2026),
      description: 'Calendar year to analyze',
    },
  },
  outputs: {
    analysis: { schema: z.string(), description: 'Written sector analysis' },
  },
});

// ─── Assemble and write the artifact ─────────────────────────────────────

const artifact = bundle(marketBlock, {
  version: '1.2.0',
  source: '@acme/market-analysis-block',
});

await writeFile(BUNDLE_PATH, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

const { manifest } = artifact;

console.log(`═══ Published ${manifest.name}@${manifest.version} ═══\n`);
console.log(`  source:  ${manifest.source}`);
console.log(`  file:    ${BUNDLE_PATH}`);
console.log(`  graphs:  1 root + ${artifact.graphs.length} embedded`);
console.log(`  agents:  ${artifact.agents.length}\n`);

console.log('  Interface');
for (const [key, decl] of Object.entries(manifest.inputs)) {
  console.log(`    in   ${(key + (decl.required ? '' : '?')).padEnd(9)} ${decl.description ?? ''}`);
}
for (const [key, decl] of Object.entries(manifest.outputs)) {
  console.log(`    out  ${key.padEnd(9)} ${decl.description ?? ''}`);
}

console.log('\n  Requires from the host');
console.log(`    models:      ${manifest.requires.models.join(', ') || '(none)'}`);
console.log(`    mcp servers: ${manifest.requires.mcp_servers.map((s) => s.id).join(', ') || '(none)'}`);
for (const required of manifest.requires.tools) {
  console.log(`    tool:        ${required.name}${required.taints ? ' (taints its output)' : ''}`);
}

console.log('\n  The tool implementation stayed behind — only its name and');
console.log('  argument schema shipped. Run consume.ts to bind one and execute.');

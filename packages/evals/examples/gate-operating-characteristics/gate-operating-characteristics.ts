/**
 * Gate Operating Characteristics — Runnable Example
 *
 * Produces the "when can you trust the retention gate?" chart: detection
 * and false-positive rates as a function of true effect size, run volume,
 * and outcome noise, measured by driving the REAL gate pipeline
 * (store → gated retrieval → ledger → evaluateRetention) with synthetic
 * outcomes of known truth.
 *
 * No LLM, no API key, fully deterministic: re-running produces identical
 * numbers. Takes ~10–30 seconds.
 *
 * Usage (from the repo root, after `npm run build`):
 *   npx tsx packages/evals/examples/gate-operating-characteristics/gate-operating-characteristics.ts
 *
 * Outputs `results.json`, `detection.svg`, `false-positives.svg`.
 */

import { gateOperatingCharacteristics } from '@cycgraph/memory';
import type { OperatingCharacteristicsRow } from '@cycgraph/memory';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// Mirror the configuration the docs recommend: 5-trial cohorts, verdicts
// expected in the early alpha brackets, undecidables retired at baseline 40.
const RETRIEVAL = { maxFacts: 8, candidateSlots: 4, restAfterTrials: 5 };
const POLICY = { minTrials: 3, maxBaselineRuns: 40 };

const EFFECTS = [-0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.3];
const RUN_COUNTS = [10, 25, 50, 100];
const NOISE = 0.1;
const REPLICATES = 50;

// ─── Charts ──────────────────────────────────────────────────────────────

const W = 720;
const H = 420;
const PAD = { top: 56, right: 170, bottom: 56, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const x = (runs: number) =>
  PAD.left + (Math.log10(runs / RUN_COUNTS[0]) / Math.log10(RUN_COUNTS[RUN_COUNTS.length - 1] / RUN_COUNTS[0])) * PLOT_W;
const y = (rate: number) => PAD.top + (1 - rate) * PLOT_H;

function frame(title: string, subtitle: string): string {
  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) =>
        `<line x1="${PAD.left}" y1="${y(v)}" x2="${W - PAD.right}" y2="${y(v)}" stroke="#e5e5e5"/>` +
        `<text x="${PAD.left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#888">${(v * 100).toFixed(0)}%</text>`,
    )
    .join('\n  ');
  const xLabels = RUN_COUNTS.map(
    (r) =>
      `<text x="${x(r).toFixed(1)}" y="${H - PAD.bottom + 20}" text-anchor="middle" font-size="11" fill="#888">${r} runs</text>`,
  ).join('\n  ');
  return `<text x="${PAD.left}" y="28" font-size="15" font-weight="600" fill="#222">${title}</text>
  <text x="${PAD.left}" y="44" font-size="12" fill="#777">${subtitle}</text>
  ${gridlines}
  ${xLabels}`;
}

function line(points: Array<{ runs: number; rate: number }>, color: string, dash = ''): string {
  const poly = points.map((p) => `${x(p.runs).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  const dots = points
    .map((p) => `<circle cx="${x(p.runs).toFixed(1)}" cy="${y(p.rate).toFixed(1)}" r="3" fill="${color}"/>`)
    .join('');
  return `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>${dots}`;
}

function legendEntry(i: number, label: string, color: string, dash = ''): string {
  const ly = PAD.top + i * 18;
  return (
    `<line x1="${W - PAD.right + 12}" y1="${ly}" x2="${W - PAD.right + 36}" y2="${ly}" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` +
    `<text x="${W - PAD.right + 42}" y="${ly + 4}" font-size="11" fill="#222">${label}</text>`
  );
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="white"/>
  ${body}
</svg>
`;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Gate operating characteristics — inference rule');
  console.log(`grid: ${EFFECTS.length} effects × ${RUN_COUNTS.length} run volumes × ${REPLICATES} replicates @ noise ${NOISE}\n`);

  const started = Date.now();
  const inference = await gateOperatingCharacteristics({
    effects: EFFECTS,
    runCounts: RUN_COUNTS,
    noiseSds: [NOISE],
    replicates: REPLICATES,
    seed: 1,
    retrieval: RETRIEVAL,
    policy: POLICY,
  });

  // Margin-rule comparison on the null effect only (its false-positive floor).
  const marginNull = await gateOperatingCharacteristics({
    effects: [0],
    runCounts: RUN_COUNTS,
    noiseSds: [NOISE],
    replicates: REPLICATES,
    seed: 1,
    retrieval: RETRIEVAL,
    policy: { ...POLICY, decisionRule: 'margin' },
  });

  // Detection means the RIGHT verdict: promotion for helpful lessons,
  // harmful-eviction for harmful ones. No-lift retirement is a separate
  // (often correct) outcome — counting it as detection would flatter the
  // negative-effect curves once maxBaselineRuns starts retiring.
  const byEffect = (effect: number) =>
    inference
      .filter((r) => r.effect === effect)
      .map((r) => ({ runs: r.runs, rate: effect >= 0 ? r.promote_rate : r.harmful_evict_rate }));

  console.log('effect       verdict ' + RUN_COUNTS.map((r) => `${r} runs`.padStart(9)).join('') + '   no-lift retired @100');
  for (const effect of EFFECTS) {
    const rows = inference.filter((r) => r.effect === effect);
    const kind = effect > 0 ? 'promote' : effect < 0 ? 'harmful' : 'false+';
    const cells =
      effect === 0
        ? rows.map((r) => r.false_promote_rate + r.false_evict_rate)
        : rows.map((r) => (effect > 0 ? r.promote_rate : r.harmful_evict_rate));
    const retired = rows[rows.length - 1].no_lift_rate;
    console.log(
      `${String(effect).padStart(5)} ${kind.padStart(12)} ` +
        cells.map((v) => `${(v * 100).toFixed(0)}%`.padStart(8)).join(' ') +
        `   ${(retired * 100).toFixed(0)}%`.padStart(8),
    );
  }

  // ── Chart 1: detection rate by run volume, per effect size ──
  const palette = ['#059669', '#0d9488', '#0891b2', '#6366f1'];
  const detectionLines: string[] = [];
  const detectionLegend: string[] = [];
  const magnitudes = [0.3, 0.2, 0.1, 0.05];
  magnitudes.forEach((mag, i) => {
    detectionLines.push(line(byEffect(mag), palette[i]));
    detectionLines.push(line(byEffect(-mag), palette[i], '5,4'));
    detectionLegend.push(legendEntry(i * 2, `+${mag} promoted`, palette[i]));
    detectionLegend.push(legendEntry(i * 2 + 1, `−${mag} evicted`, palette[i], '5,4'));
  });

  const detectionSvg = svg(
    frame(
      'How much evidence does the gate need?',
      `detection rate vs run volume at noise SD ${NOISE} — ${REPLICATES} seeded replicates per point, real gate pipeline`,
    ) + detectionLines.join('\n  ') + detectionLegend.join('\n  '),
  );

  // ── Chart 2: false-positive floor, inference vs margin rule ──
  const nullInference = inference
    .filter((r) => r.effect === 0)
    .map((r) => ({ runs: r.runs, rate: r.false_promote_rate + r.false_evict_rate }));
  const nullMargin = marginNull.map((r) => ({ runs: r.runs, rate: r.false_promote_rate + r.false_evict_rate }));

  const fpSvg = svg(
    frame(
      'False decisions on a lesson with NO effect',
      `the price of deciding fast: margin rule vs statistical inference (noise SD ${NOISE})`,
    ) +
      line(nullMargin, '#dc2626') +
      line(nullInference, '#059669') +
      legendEntry(0, 'margin rule', '#dc2626') +
      legendEntry(1, 'inference rule', '#059669'),
  );

  const results = {
    config: { retrieval: RETRIEVAL, policy: POLICY, noiseSd: NOISE, replicates: REPLICATES, seed: 1 },
    inference,
    margin_null: marginNull,
  };

  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT_DIR, 'detection.svg'), detectionSvg);
  writeFileSync(join(OUT_DIR, 'false-positives.svg'), fpSvg);

  console.log(`\ncompleted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`Wrote ${join(OUT_DIR, 'results.json')}`);
  console.log(`Wrote ${join(OUT_DIR, 'detection.svg')}`);
  console.log(`Wrote ${join(OUT_DIR, 'false-positives.svg')}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Satisfy the unused-type import check when tree-shaken builds analyze this file.
export type { OperatingCharacteristicsRow };

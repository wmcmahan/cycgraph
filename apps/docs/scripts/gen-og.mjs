// Generates the static Open Graph share card → public/og-default.png (1200×630).
// Dev-only: run `node scripts/gen-og.mjs` to regenerate after branding changes.
// The committed PNG is what ships; @resvg/resvg-js is not needed at build/runtime.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="20%" cy="-5%" r="85%">
      <stop offset="0%" stop-color="#5b6cff" stop-opacity="0.20"/>
      <stop offset="55%" stop-color="#5b6cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#090b11"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="1200" height="5" fill="#5b6cff"/>

  <!-- logo glyph (from the favicon), scaled -->
  <g transform="translate(72,58) scale(2.9)">
    <rect x="0.7" y="0.7" width="30.6" height="30.6" rx="8" fill="#0d0f17" stroke="#23283a"/>
    <path d="M16 7 L25 16 L16 25 L7 16 Z" stroke="#2a3142" stroke-width="1.3" fill="none"/>
    <path d="M16 7 L25 16 L16 25 L7 16 Z" stroke="#5b6cff" stroke-width="1.3" stroke-dasharray="2.6 3" opacity="0.75" fill="none"/>
    <circle cx="16" cy="7" r="2.4" fill="#0d0f17" stroke="#5b6cff" stroke-width="1.5"/>
    <circle cx="25" cy="16" r="2.4" fill="#0d0f17" stroke="#34e2e8" stroke-width="1.5"/>
    <circle cx="16" cy="25" r="2.4" fill="#0d0f17" stroke="#5b6cff" stroke-width="1.5"/>
    <circle cx="7" cy="16" r="2.4" fill="#0d0f17" stroke="#5b6cff" stroke-width="1.5"/>
    <circle cx="16" cy="16" r="2.3" fill="#34e2e8"/>
  </g>

  <text x="188" y="121" font-family="Menlo, monospace" font-size="40" font-weight="700" letter-spacing="6" fill="#e7ecf4">CYCGRAPH</text>
  <rect x="498" y="90" width="78" height="36" rx="18" fill="#34e2e8" fill-opacity="0.12" stroke="#34e2e8" stroke-opacity="0.4"/>
  <text x="537" y="115" font-family="Menlo, monospace" font-size="18" font-weight="700" letter-spacing="2" fill="#34e2e8" text-anchor="middle">BETA</text>

  <text x="70" y="330" font-family="Georgia, serif" font-size="96" fill="#e7ecf4">Agentic orchestration</text>
  <text x="70" y="438" font-family="Georgia, serif" font-size="96" fill="#e7ecf4">that <tspan font-style="italic" fill="#34e2e8">loops.</tspan></text>

  <text x="74" y="522" font-family="Menlo, monospace" font-size="27" fill="#9298a8">Beyond the DAG — durable, auditable, zero-trust.</text>
  <text x="74" y="576" font-family="Menlo, monospace" font-size="25" fill="#5a6072">$ npm install <tspan fill="#8ea0ff">@cycgraph/orchestrator</tspan></text>
</svg>`;

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  font: { loadSystemFonts: true },
});
const png = resvg.render().asPng();
const out = new URL('../public/og-default.png', import.meta.url);
writeFileSync(out, png);
console.log(`wrote public/og-default.png (${png.length} bytes)`);

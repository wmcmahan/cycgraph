import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import mdx from '@astrojs/mdx';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// Docs moved from `/` to `/docs`. Build concrete per-page redirects from the
// actual content files so each destination is a real Starlight route (Astro 6
// rejects spread-param redirects that resolve via Starlight's catch-all).
// The old root `/` is NOT redirected — it is now the marketing landing page.
function buildDocsRedirects() {
  const docsRoot = fileURLToPath(new URL('./src/content/docs/docs', import.meta.url));
  const redirects = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.mdx?$/.test(entry.name)) {
        const slug = relative(docsRoot, full)
          .replace(/\\/g, '/')
          .replace(/\.mdx?$/, '')
          .replace(/\/index$/, '');
        if (slug === 'index' || slug === '') continue; // `/docs/` itself, no old URL
        redirects[`/${slug}`] = `/docs/${slug}/`;
      }
    }
  };
  walk(docsRoot);
  return redirects;
}

export default defineConfig({
  site: 'https://flattop.io/',
  adapter: vercel(),
  output: 'static',

  redirects: buildDocsRedirects(),

  integrations: [
    mermaid({ autoTheme: true }), // must come before starlight
    starlight({
      customCss: ['./src/styles/starlight-theme.css'],
      head: [
        {
          tag: 'script',
          attrs: { defer: true, src: '/_vercel/insights/script.js' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
          },
        },
        // SEO: social cards + theme color for docs pages.
        { tag: 'meta', attrs: { name: 'theme-color', content: '#090b11' } },
        { tag: 'meta', attrs: { property: 'og:site_name', content: 'cycgraph' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://flattop.io/og-default.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://flattop.io/og-default.png' } },
        // SEO: product structured data on every docs page.
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'cycgraph',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Node.js 22+',
            description:
              'Agentic orchestration built on a Cyclic State Graph architecture.',
            url: 'https://flattop.io/',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            sameAs: [
              'https://github.com/wmcmahan/cycgraph',
              'https://www.npmjs.com/package/@cycgraph/orchestrator',
            ],
          }),
        },
      ],
      title: 'cycgraph',
      description:
        'Agentic orchestration built on a Cyclic State Graph architecture.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/wmcmahan/cycgraph' },
      ],
      editLink: {
        baseUrl: 'https://github.com/wmcmahan/cycgraph/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'docs/getting-started/introduction' },
            { label: 'Quick Start', slug: 'docs/getting-started/quick-start' },
          ],
        },
        {
          label: 'Core Concepts',
          items: [
            { label: 'How cycgraph works', slug: 'docs/concepts/overview' },
            { label: 'Graphs', slug: 'docs/concepts/graphs' },
            { label: 'Nodes', slug: 'docs/concepts/nodes' },
            { label: 'Agents', slug: 'docs/concepts/agents' },
            { label: 'Workflow State', slug: 'docs/concepts/workflow-state' },
            { label: 'Tools & MCP', slug: 'docs/concepts/tools-and-mcp' },
            { label: 'Streaming', slug: 'docs/concepts/streaming' },
            { label: 'Middleware', slug: 'docs/concepts/middleware' },
            { label: 'Cost & Budget Tracking', slug: 'docs/concepts/cost-tracking' },
            { label: 'Taint Tracking', slug: 'docs/concepts/taint-tracking' },
            { label: 'Context Engine', slug: 'docs/concepts/context-engine' },
            { label: 'Memory System', slug: 'docs/concepts/memory' },
            { label: 'Persistence', slug: 'docs/concepts/persistence' },
            { label: 'Distributed Execution', slug: 'docs/concepts/distributed-execution' },
            { label: 'Error Handling', slug: 'docs/concepts/error-handling' },
          ],
        },
        {
          label: 'Workflow Patterns',
          items: [
            { label: 'Supervisor', slug: 'docs/patterns/supervisor' },
            { label: 'Evolution (DGM)', slug: 'docs/patterns/evolution' },
            { label: 'Reflection', slug: 'docs/patterns/reflection' },
            { label: 'Self-Annealing', slug: 'docs/patterns/self-annealing' },
            { label: 'Swarm', slug: 'docs/patterns/swarm' },
            { label: 'Voting / Consensus', slug: 'docs/patterns/voting' },
            { label: 'Verifier', slug: 'docs/patterns/verifier' },
            { label: 'Human-in-the-Loop', slug: 'docs/patterns/human-in-the-loop' },
            { label: 'Map-Reduce', slug: 'docs/patterns/map-reduce' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Your First Workflow', slug: 'docs/guides/first-workflow' },
            { label: 'Custom LLM Providers', slug: 'docs/guides/custom-providers' },
            { label: 'Adding MCP Tools', slug: 'docs/guides/adding-tools' },
            { label: 'Budget-Aware Model Selection', slug: 'docs/guides/model-selection' },
            { label: 'Context Engine', slug: 'docs/guides/context-engine' },
            { label: 'Using Memory', slug: 'docs/guides/memory' },
            { label: 'Using the Architect', slug: 'docs/guides/architect' },
          ],
        },
        {
          label: 'Observability',
          items: [
            { label: 'Tracing', slug: 'docs/observability/tracing' },
            { label: 'Graph Assertions (runEval)', slug: 'docs/observability/evals' },
          ],
        },
        {
          label: 'Eval Harness',
          items: [
            { label: 'Overview', slug: 'docs/concepts/eval-harness' },
            { label: 'Assertions', slug: 'docs/concepts/eval-assertions' },
            { label: 'Drift & Baselines', slug: 'docs/concepts/drift-and-baselines' },
            { label: 'Running Evals', slug: 'docs/guides/running-eval-harness' },
            { label: 'Recording Goldens', slug: 'docs/guides/recording-goldens' },
            { label: 'Adding an Eval Suite', slug: 'docs/guides/adding-eval-suite' },
            { label: 'Adding a SUT Handler', slug: 'docs/guides/adding-sut-handler' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'Deployment Guide', slug: 'docs/operations/deployment' },
            { label: 'Configuration Reference', slug: 'docs/operations/configuration' },
          ],
        },
        { label: 'Security', slug: 'docs/security' },
      ],
    }),
    mdx(),
  ],

  // Tailwind v4 via the Vite plugin (Astro 6 dropped @astrojs/tailwind).
  // Preflight is scoped to marketing/blog pages by import location: the entry
  // stylesheet is imported only in SiteLayout.astro, never in Starlight's CSS.
  vite: { plugins: [tailwindcss()] },
});

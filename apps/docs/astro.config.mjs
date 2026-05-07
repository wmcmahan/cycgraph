import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://flattop.io/',
  adapter: vercel(),
  output: 'static',
  integrations: [
    mermaid({ autoTheme: true }), // must come before starlight
    starlight({
      head: [
        {
          tag: 'script',
          attrs: { defer: true, src: '/_vercel/insights/script.js' },
        },
      ],
      title: 'MC-AI',
      description:
        'Agentic orchestration built on a Cyclic State Graph architecture.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/wmcmahan/mc-ai' },
      ],
      editLink: {
        baseUrl: 'https://github.com/wmcmahan/mc-ai/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
            { label: 'Troubleshooting', slug: 'getting-started/troubleshooting' },
          ],
        },
        {
          label: 'Core Concepts',
          items: [
            { label: 'How MC-AI Works', slug: 'concepts/overview' },
            { label: 'Graphs', slug: 'concepts/graphs' },
            { label: 'Nodes', slug: 'concepts/nodes' },
            { label: 'Agents', slug: 'concepts/agents' },
            { label: 'Workflow State', slug: 'concepts/workflow-state' },
            { label: 'Tools & MCP', slug: 'concepts/tools-and-mcp' },
            { label: 'Streaming', slug: 'concepts/streaming' },
            { label: 'Middleware', slug: 'concepts/middleware' },
            { label: 'Cost & Budget Tracking', slug: 'concepts/cost-tracking' },
            { label: 'Taint Tracking', slug: 'concepts/taint-tracking' },
            { label: 'Context Engine', slug: 'concepts/context-engine' },
            { label: 'Memory System', slug: 'concepts/memory' },
            { label: 'Persistence', slug: 'concepts/persistence' },
            { label: 'Distributed Execution', slug: 'concepts/distributed-execution' },
            { label: 'Error Handling', slug: 'concepts/error-handling' },
          ],
        },
        {
          label: 'Workflow Patterns',
          items: [
            { label: 'Supervisor', slug: 'patterns/supervisor' },
            { label: 'Evolution (DGM)', slug: 'patterns/evolution' },
            { label: 'Self-Annealing', slug: 'patterns/self-annealing' },
            { label: 'Swarm', slug: 'patterns/swarm' },
            { label: 'Human-in-the-Loop', slug: 'patterns/human-in-the-loop' },
            { label: 'Map-Reduce', slug: 'patterns/map-reduce' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Your First Workflow', slug: 'guides/first-workflow' },
            { label: 'Custom LLM Providers', slug: 'guides/custom-providers' },
            { label: 'Adding MCP Tools', slug: 'guides/adding-tools' },
            { label: 'Budget-Aware Model Selection', slug: 'guides/model-selection' },
            { label: 'Using the Context Engine', slug: 'guides/context-engine' },
            { label: 'Using Memory', slug: 'guides/memory' },
            { label: 'Using the Architect', slug: 'guides/architect' },
          ],
        },
        {
          label: 'Observability',
          items: [
            { label: 'Tracing', slug: 'observability/tracing' },
            { label: 'Evaluations', slug: 'observability/evals' },
          ],
        },
        { label: 'Security', slug: 'security' },
      ],
    }),
  ],
});

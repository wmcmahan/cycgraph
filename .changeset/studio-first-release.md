---
"@cycgraph/studio": patch
---

First release of the cycgraph studio: install as a dev dependency, declare your graphs in a project-root `cycgraph.config`, and run `cycgraph-studio` — the dashboard, counterfactual forking, insights, and the tune/improve ladder over your own workflows. TypeScript configs and graph modules load through tsx's runtime loader under the plain-node bin, sharing one module cache so inline agents and tools thread correctly. The dashboard is a Next.js app statically exported at build time and served by the studio's own node server — React and Next are build-time tools, never consumer dependencies.

# @cycgraph/studio

The studio is how you watch cycgraph work: a dashboard and CLI for running
workflows, reading their logs, measuring what they cost, forking recorded
runs to ask "what if", and walking measured improvements from proposal to
pull request. It is scenario-agnostic. You point it at your graphs; it
supplies every verb over them.

## Quickstart

Install the studio into your cycgraph project and declare your workflows
in a root-level config:

```bash
npm install -D @cycgraph/studio
```

```ts
// cycgraph.config.ts
export default {
  graphs: ['./graphs/order-flow.ts'],
  model: 'qwen2.5:7b',          // any model your providers resolve
  artifactRoot: './.cycgraph',  // where run artifacts land, config-relative
  repo: '.',                    // where the apply rung writes source changes
};
```

```jsonc
// package.json
"scripts": { "studio": "cycgraph-studio" }
```

A graph module default-exports a scenario-shaped object: an `id`, a
`title`, a zod `params` schema (rendered as CLI flags and dashboard form
alike), and a `build(params, stack)` returning the graph and its input.
Author the graph with the `@cycgraph/orchestrator` facade; inline agents
and tools are discovered automatically.

```bash
npm run studio                       # list your catalog and stack status
npm run studio -- run order-flow --items 5
npm run studio -- serve              # the dashboard on 127.0.0.1:5199
```

Durable history, the run browser, and forking across processes want
Postgres; the cycgraph repo's `docker-compose up -d` provides it (with
Jaeger for traces), or point `DATABASE_URL` at your own pgvector
instance. Without one the studio still runs — in memory, honestly
reporting the gap.

Working inside the cycgraph monorepo instead? `npm run studio` at the
repo root serves the same CLI from source, and finds your config in
whichever directory you invoke it from.

No config is needed to start: `run ./some-graph.ts` loads a file directly,
`serve --load ./some-graph.ts` puts it in the picker, and every run
recorded into the shared Postgres by any process appears in the
dashboard's Database-runs view, inspectable and forkable.

## What the dashboard gives you

- **Logs** — a cross-run explorer: facets, live tail, drill-in to any
  line's run card and timings, plus the Database-runs browser for runs
  your own applications recorded through the engine.
- **Improve** — the measurement loop: the watcher, tune passes over your
  recorded corpus, proposals with their evidence tables, trial overlays,
  and an apply flow that edits, verifies, and commits to a branch. The
  one thing it never does is push; the PR script stays a copy button.
- **Scenarios** — the run surface: your catalog, schema-driven parameter
  forms, and the graph rendered live while a run executes.

## Runs your own application makes

Point your app's `runRecorded` at the same Postgres and its runs appear in
the dashboard's Database-runs view — inspectable and forkable with no
further wiring. To bring one into the measurement layer too, import it:

```bash
npm --prefix $STUDIO run studio -- import <runId>     # or --all
```

Importing reconstructs the run's artifacts from the event log: per-node
timings (child boundaries included), usage from the final state, and a
history entry under the graph's name. If your config declares a graph with
that same name, the imported corpus has a knob source and `tune` works over
it end to end. What import cannot conjure it leaves absent: log lines went
to your process's logger, and evals exist only where a scenario declares
them. The dashboard's Database-runs table has an Import button for the
same operation.

## Config reference

| Field | Meaning |
|-------|---------|
| `graphs` | Workflow modules (`.ts`/`.mjs`) or bundle files (`.json`), config-relative |
| `model` | Model id every agent resolves through |
| `tenant` | Tenant Postgres-backed runs open against |
| `artifactRoot` | Run artifact directory, config-relative |
| `postgres` / `jaeger` / `servers` / `memory` | Opt out of stack features |
| `repo` | Repository the apply rung clones and commits to |

Every CLI flag overrides its config counterpart. The config file may be
`.ts`, `.mts`, `.mjs`, `.js` (default export) or `.json`.

## Boundaries worth knowing

- The dashboard binds loopback only. It runs whatever a request names,
  which is fine for a local tool and would not be anywhere else.
- A graph file resolves its imports from its own location, so keep your
  graphs inside your project where its dependencies resolve.
- Bundles carry no code: a bundle whose manifest requires host tools is
  refused at load, with a pointer to the module form that can supply them.

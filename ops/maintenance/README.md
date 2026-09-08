# @cycgraph/maintenance

This repository's maintenance workflows: project operations, not a
product package. Each workflow keeps some part of the repository honest,
following one pattern — sense mechanically, act with a jailed agent,
judge by re-scanning, gate, then deliver a branch and a pull request.
The human gate is the merge.

Workflows are defined harness-free (`MaintenanceWorkflow`, engine
vocabulary only) on `@cycgraph/orchestrator` and `@cycgraph/tools`. The
playground registers them in its catalog for interactive runs; the
headless runner here is what CI uses.

## Workflows

| Id | Scope |
|----|-------|
| `repo-docs` | READMEs, guides, everything outside the website |
| `website-docs` | The documentation site under `apps/docs` |
| `docs-maintenance` | Both at once — the unsplit original |
| `core-upkeep` | Owed upkeep (TODOs, skipped tests, lint warnings) filed as deduped GitHub issues; no model, nothing edited |
| `issue-fix` | Fixes one approved upkeep issue: re-locates the finding, fixes, judges against the class's anti-gaming guard, then a reviewer pass over the diff before the PR |
| `opt-propose` | Benchmarks, makes one optimization, re-benchmarks; a verified improvement becomes a ticket carrying the measured table and diff — never a PR |
| `feat-propose` | Studies the codebase read-only and files one well-formed feature ticket: motivation, design, evidence naming real files, mechanical acceptance criteria |
| `opt-apply` | Implements one approved optimization ticket: re-applies its verified diff, re-benchmarks, PRs only if the improvement still holds; no model |
| `feat-implement` | Implements one approved feature ticket against its own acceptance criteria; runnable criteria execute as the judge, the rest wait for PR review |
| `pr-revise` | Addresses human review feedback on a maintenance PR: reads the comments, revises the same branch so the PR updates in place, and replies with what changed |

## Running

Headless, from the repository root (CI uses exactly this):

```bash
npm run maintain --workspace=ops/maintenance -- repo-docs --batch 3
```

The runner fetches first and refuses to run against a repository that
is behind its origin's default branch — a stale local repository
re-finds work that is already merged and delivers a duplicate PR. Pull
first, or pass `--allowStale true` deliberately. Offline counts as
"cannot tell", not stale, and the run proceeds.

Flags mirror the workflow's params: `--batch n` (fixes per run, one
commit each, one PR), `--since <ref>` (diff mode: only findings a change
since that ref plausibly staled), `--skip n`, `--commit false` (inspect
without committing), `--publish false` (commit but leave the prepared
publish script), `--checks "npm run lint"`. For `core-upkeep`:
`--maxIssues n`, `--lint false` (grep classes only), `--file false`
(report what would be filed, touch nothing). Each filed issue carries a
stable finding marker, dedupe runs against every open issue's markers,
and when the issue ledger cannot be read the run reports that and
refuses to file rather than filing blind. For `issue-fix`:
`--label <name>` (which label counts as approval), `--issueNumber n`
(fix a specific issue), and `--key <finding-key>` (detached mode: fix a
named finding without reading or closing any issue — how the cycle runs
without GitHub). For `opt-propose`: `--target <bench filter>`,
`--minImprovement n` (percent a proposal must measure, beyond the two
runs' combined error margins), `--scope <dir>` (changes outside it are
refused), `--attempts n`. For `feat-propose`: `--focus <area>` steers
the proposal; the gate is structural, and the quality gate is you —
approve a ticket only when its evidence and acceptance criteria hold
up. For `pr-revise`: `--pr n` names the pull request whose feedback is
addressed. For `opt-apply` and `feat-implement`: `--issueNumber n` targets a
specific ticket, and `--ticketFile <path>` runs the same cycle from a
saved ticket body without reading or closing anything on GitHub — how
both are testable locally. Acceptance criteria only execute when they
match a safe allowlist of repository script shapes; anything else waits
for the PR review. Benchmarks resolve the orchestrator from the
clone's own source via aliases, so the edit is what gets measured, and
both sides of the comparison run the same way. Pass the repository's
test suite as `--checks` when filing for real: the benchmark cannot
tell faster from doing less, so correctness rides on the checks.

Interactively, through the playground catalog:

```bash
npm run play -- run repo-docs --batch 2 --publish false
```

## Environment

| Variable | Purpose |
|----------|---------|
| `CYCGRAPH_MODEL` | Fixer model (default `qwen2.5:7b` via local Ollama) |
| `CYCGRAPH_PROVIDER` | Override the provider inferred from the model id |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Hosted-model credentials |
| `OLLAMA_BASE_URL` | Local model server (default `http://localhost:11434`) |
| `DATABASE_URL` | Set it and the run records into shared Postgres, joining the corpus the studio's improvement watcher imports and measures; unset, the run records in-memory and is gone with the process |
| `GH_TOKEN` | Token `gh` uses to open the pull request |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | Commit identity (both required; default `cycgraph-workflow`) |

## CI

`.github/workflows/core-upkeep.yml` runs the upkeep sense weekly with
the built-in token (issues write is all it needs).
`.github/workflows/issue-fix.yml` runs the fix cycle weekly: one
approved issue per run, eslint as the pre-commit check, exiting clean
when nothing carries the approval label.
`.github/workflows/docs-maintenance.yml` runs both docs scopes nightly
(batched full scan) and on every push to main (diff mode over the
pushed change). It needs the `ANTHROPIC_API_KEY` secret, and a
fine-grained `MAINTENANCE_PAT` secret with contents and pull-requests
write — pull requests created with the built-in `GITHUB_TOKEN` do not
trigger CI, so without the PAT the maintenance PRs arrive without
checks. Runs never merge anything, and the scan defers findings any
open `docs/*` pull request already touches.
`.github/workflows/pr-revise.yml` closes the human-in-the-loop review
cycle: a changes-requested review on a maintenance branch, or a PR
comment mentioning `@cycgraph`, dispatches a run that reads the
feedback, revises the same branch so the pull request updates in place,
and replies with what changed. The human verdict still ends every
thread; the run never merges.

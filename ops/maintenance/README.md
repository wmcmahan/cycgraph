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
publish script), `--checks "npm run build:libs,npm run lint:eslint,npm test"`
(comma-separated; a command containing a comma cannot be passed). For `core-upkeep`:
`--maxIssues n`, `--lint false` (grep classes only), `--file false`
(report what would be filed, touch nothing). Each filed issue carries a
stable finding marker, dedupe runs against every open issue's markers,
and when the issue ledger cannot be read the run reports that and
refuses to file rather than filing blind. For `issue-fix`:
`--label <name>` (which label counts as approval), `--issueNumber n`
(fix a specific issue), and `--key <finding-key>` (detached mode: fix a
named finding without reading or closing any issue — how the cycle runs
without GitHub). An `audit:` key names a finding whose whole
specification is its issue text, so detached mode also needs
`--ticketFile <path>` carrying that body; without it the run refuses
rather than briefing the fixer with an empty spec. For `opt-propose`: `--target <bench filter>`,
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

Two ledger-only subcommands run without a graph. `memory-gate` runs the
promote/evict gate over the candidate lesson pool. `reconcile-outcomes`
scores every recently recorded run that published a PR by what became
of it — merged records 1, closed-unmerged records 0, still-open waits —
so human merge decisions become outcome evidence for the lessons those
runs carried. `--sinceDays n` bounds the window (default 14) and
`--apply false` reports what would be recorded without touching the
ledger. `stats` prints the fleet scorecard — per-workflow completion,
gate-pass and lesson-injection rates, reconciled outcomes, tokens,
cost, and learning-tail degradations — over the same `--sinceDays`
window, reading only what runs already recorded. All three need
`DATABASE_URL`.

`tune` closes the structural loop: it senses a target workflow's
failures from the corpus, has an analyst propose one edit to that
workflow's own instructions, trials control against variant as dry
subprocess runs from a patched clone, and files a winning proposal as
a marker-keyed ticket carrying the hypothesis, the measured table, and
the exact diff. `--target <workflow>` picks the subject,
`--trials n` sets runs per arm, `--file false` reports without filing.
`tune` itself needs `DATABASE_URL` — the corpus is its sensor — but its
trials run with the credential stripped, so the corpus never records
them and neither arm gets lesson injection. The ticket rides
the same `maintenance-approved` ladder as everything else — the tune
loop proposes, the human disposes.

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

`.github/workflows/core-upkeep.yml` runs the upkeep sense on manual dispatch with
the built-in token (issues write is all it needs).
`.github/workflows/issue-fix.yml` is the queue dispatcher described
under "The automated pipeline" below: it fires on the approval label
and on every merged maintenance PR (no cron — a dropped event is
recovered by a manual dispatch), one issue per run, worst severity
first, never while another maintenance PR is open. Eslint is the pre-commit check, and the run exits clean when
nothing carries the label.
`.github/workflows/docs-maintenance.yml` runs both docs scopes on
manual dispatch (batched full scan) and on every push to main (diff mode over the
pushed change). It needs the `ANTHROPIC_API_KEY` secret, and a
fine-grained `MAINTENANCE_PAT` secret with contents and pull-requests
write — pull requests created with the built-in `GITHUB_TOKEN` do not
trigger CI, so without the PAT the maintenance PRs arrive without
checks. Runs never merge anything, and the scan defers findings any
open `docs/*` pull request already touches.
`.github/workflows/reconcile-outcomes.yml` runs the outcome reconciler
on manual dispatch; run it after recent pull requests have had their
chance to be merged or closed, or the lesson ledger accrues no outcomes. It needs the `DATABASE_URL` secret — without a
ledger there is nothing to record — and a token that can read PR states.
`.github/workflows/pr-revise.yml` closes the human-in-the-loop review
cycle: a changes-requested review on a maintenance branch, or a review
or PR comment mentioning `@cycgraph`, dispatches a run that reads the
feedback, revises the same branch so the pull request updates in place,
and replies with what changed. The human verdict still ends every
thread; the run never merges.

## The automated pipeline

With the flags the workflow files now set, the whole ladder runs without
a human touch on the happy path. The audit and upkeep workflows file
issues pre-approved (`--approve true`), so the queue is simply the open
`maintenance-approved` issues. `.github/workflows/issue-fix.yml` is the
dispatcher over that queue: it fires on the approval label and on every
merged maintenance PR (no cron — a dropped event is recovered by a
manual dispatch), and it holds
one fix in flight end-to-end — a constant concurrency group serializes
runs, and a gate step yields while any `maintenance-managed` PR is
open. Because the next fix only starts after the previous one merged,
every branch cuts from a main that already contains the last change,
which is what keeps merge conflicts out of the pipeline. The picker
takes the worst `severity:*` label first and the oldest issue within a
severity. On the way out, pr-review runs with `--merge true`: an
APPROVE verdict on a managed PR arms squash auto-merge (deleting the
branch), the merge closes the issue, and the merge event dispatches the
next pick. A REVISE verdict still routes through pr-revise, bounded by
the rounds cap.

Both fix and revise workspaces run the repository's own tests before
any commit or push: the `--checks` the workflow files pass are
`npm run build:libs,npm run lint:eslint,npm test`. The build comes
first for two distinct reasons. A file that imports its own package's
name resolves through that package's exports against the clone (Node
self-reference, no node_modules involved), so without a clone build
those tests cannot resolve at all. And the build is the type check on
the fixer's edits before anything publishes. Cross-package imports
resolve to the clone too: `linkNestedModules` links every internal
package at the workspace group level (`packages/node_modules/...`),
which sits earlier on Node's resolution walk than the root symlink to
the checkout's dependency tree, so a consumer's build sees what the
clone's own build produced. Without those links a cross-package fix
was an unwinnable gate — an edit to a dependency's source could never
reach its consumers' type checks, which resolved the checkout's stale
build instead (issue #301 burned two full runs exactly this way). When a PR's CI still fails after publish,
`.github/workflows/pr-ci-failure.yml` reacts — the first failure
dispatches pr-revise with the failing run linked, a repeat failure
labels the PR `needs-human` instead of cycling, and a green run on a
labeled PR clears the label.

An issue whose fix spends its whole retry budget without green checks
is labeled `needs-human` too, with the failing output in a comment; the
picker skips labeled issues, and removing the label re-queues one.

When the loop gives up on a PR — a review inconclusive
after its diff-only fallback, a review that could not be submitted, a
failed revision run, or an exhausted rounds cap — the PR is labeled
`needs-human` with a comment saying why, so limbo is never silent: the
PR list shows exactly which PRs wait on a decision, the dispatcher's
idle-gate notice names them, and a later successful review or revision
clears the label on its own. That label, unlabeling an issue, disabling
auto-merge, and closing a PR are where the human hand remains. Enable "Allow
auto-merge" in the repository settings; without it the merge step falls
back to a direct merge, which only succeeds when the checks are already
green.

## Running the PR loop locally

Every workflow in the loop runs from your machine with two credentials:
`gh auth login` (the same `gh` the tools shell out to) and a valid
`ANTHROPIC_API_KEY` in the environment. Run from a fresh pull of main —
the runner refuses a repository that is behind its origin. Leave
`DATABASE_URL` unset locally unless you want the run recorded into the
shared corpus.

```bash
# Review a PR without touching GitHub: full gather, review, verdict,
# inline-anchor computation — the review text prints instead of posting.
npm run maintain --workspace=ops/maintenance -- pr-review --pr 256 --comment false

# Post for real from your machine (your gh token, not the CI secret):
npm run maintain --workspace=ops/maintenance -- pr-review --pr 256

# Revise a PR without pushing: edits land in a workspace under /tmp for
# inspection, and the run prints its path and diff.
npm run maintain --workspace=ops/maintenance -- pr-revise --pr 256 --push false --checks "npm run lint:eslint"

# Fix an approved issue end-to-end without publishing:
npm run maintain --workspace=ops/maintenance -- issue-fix --commit false
```

A failure that only appears in CI and not in a local run of the same
command is a credential or environment difference, and the CI secrets
(`MAINTENANCE_PAT`, `DATABASE_URL`) are the first place to look.
Forensics for any recorded run live in Postgres: connect with the
maintenance role, `set app.tenant_id =
'00000000-0000-0000-0000-000000000001'`, and the run's full state —
every node result, the exact prompts' task context, injected lessons —
is in `workflow_states` by `run_id`.

/**
 * The proposals ledger
 *
 * Where a verified proposal waits for a human. `tune --save` writes one per
 * winning sweep with its whole evidence chain; `play apply` marks it applied;
 * the run path applies every accepted proposal at build time and stamps the
 * run with what it ran under. The loop closes here without gaining autonomy:
 * every transition is a person's command, and every run says which proposals
 * shaped it.
 *
 * A proposal's id is its sweep id, which is derived from what the sweep is
 * about — so re-tuning the same knob updates the same ledger entry rather
 * than accumulating rivals. A resave keeps `applied` status only while the
 * change itself is unchanged: new evidence proposing a different value is a
 * new decision, and it does not inherit the old one's acceptance.
 *
 * @module improve/proposals
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalEquals, detectConflicts } from '@cycgraph/orchestrator';
import type { Change } from '@cycgraph/orchestrator';
import type { SweepProposal } from '@cycgraph/evals';
import type { TuneOutcome } from './tune.js';
import type { VariantOutcome } from '@cycgraph/evals';

/** Where the ledger lives under the artifact root. */
const DIR = 'proposals';

/** A proposal at rest, with everything a reviewer needs to decide. */
export interface ProposalRecord {
  /** The sweep id, which is what makes re-tuning update rather than duplicate. */
  id: string;
  workflow: string;
  nodeId: string;
  knob: string;
  from: SweepProposal['from'];
  to: SweepProposal['to'];
  objective: SweepProposal['objective'];
  model: string;
  change: Change[];
  computeDelta: number;
  tokenDelta: number;
  measuredOn: string[];
  reliability?: SweepProposal['reliability'];
  /** What the held-out confirmation concluded, when one ran. */
  validation?: { confirmed: boolean; detail: string };
  /** What measuring the composed winners concluded, when a pass composed any. */
  combination?: string;
  /**
   * The change that undoes this one, captured from the source at apply time.
   *
   * Recorded then rather than derived later because `from` alone cannot
   * rebuild a prompt or a config container, and the ledger must be able to
   * take a change back out of code without the code's history.
   */
  inverse?: Change[];
  /**
   * The exact source edit the apply made.
   *
   * Kept so revert can be the deterministic swap of the pair — byte-exact
   * restoration — rather than asking a model to reconstruct what the source
   * used to say.
   */
  edit?: { find: string; replace: string };
  /** Where the edit lives while it awaits review. */
  branch?: string;
  /** The clone holding the commit, until the PR is pushed. */
  workspace?: string;
  /** The prepared push-and-PR command, printed for a person to run. */
  prCommand?: string;
  /** The committed edit as a patch, stored at apply time so it outlives the workspace. */
  diff?: string;
  /**
   * The per-variant measurements the verdict was decided on.
   *
   * Stored with the proposal so a reviewer drilling in sees the evidence
   * table, not just the deltas summarized from it.
   */
  evidence?: VariantOutcome[];
  /**
   * The ladder: `trial` runs the change as a runtime overlay, instantly
   * reversible; `pr` means the editor workflow has committed it to a branch
   * in a disposable clone and the pull request awaits a person; `applied`
   * means the review merged it — the code is the record. A proposal earns
   * its way up one rung at a time.
   */
  status: 'proposed' | 'trial' | 'pr' | 'applied' | 'reverted';
  savedAt: string;
  statusChangedAt: string;
}

/** The ledger entry's file name: the sweep id, made filesystem-safe. */
function fileOf(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.json`;
}

async function readAll(artifactRoot: string): Promise<ProposalRecord[]> {
  const dir = join(artifactRoot, DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const records: ProposalRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as ProposalRecord);
    } catch {
      // A half-written record is not a decision anyone made.
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

async function write(artifactRoot: string, record: ProposalRecord): Promise<void> {
  const dir = join(artifactRoot, DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileOf(record.id)), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Persist a tune pass's winning proposals.
 *
 * Only winners: rejections are results worth reading in the pass's report,
 * but a ledger of things not to do is noise. A proposal whose held-out
 * confirmation failed is saved with that verdict attached — the reviewer
 * decides what a refuted winner is worth, not the ledger.
 */
export async function saveProposals(
  artifactRoot: string,
  outcome: TuneOutcome,
): Promise<string[]> {
  const existing = new Map((await readAll(artifactRoot)).map(r => [r.id, r]));
  const now = new Date().toISOString();
  const saved: string[] = [];

  for (const verdict of outcome.verdicts) {
    if (verdict.kind !== 'proposal') continue;
    const proposal = verdict.proposal;
    const validation = outcome.validations?.[proposal.sweepId];
    const prior = existing.get(proposal.sweepId);
    // Acceptance survives a resave only while the change itself is unchanged.
    const keepStatus = prior && canonicalEquals(prior.change, proposal.change);

    const record: ProposalRecord = {
      id: proposal.sweepId,
      workflow: proposal.workflow,
      nodeId: proposal.nodeId,
      knob: proposal.knob,
      from: proposal.from,
      to: proposal.to,
      objective: proposal.objective,
      model: proposal.model,
      change: [...proposal.change],
      computeDelta: proposal.computeDelta,
      tokenDelta: proposal.tokenDelta,
      measuredOn: [...proposal.measuredOn],
      ...(proposal.outcomes.length > 0 ? { evidence: [...proposal.outcomes] } : {}),
      ...(proposal.reliability ? { reliability: proposal.reliability } : {}),
      ...(validation
        ? {
          validation: validation.kind === 'proposal'
            ? { confirmed: true, detail: `held on ${validation.proposal.measuredOn.length} held-out base run(s)` }
            : { confirmed: false, detail: validation.rejection.reason },
        }
        : {}),
      ...(outcome.combination && !('skipped' in outcome.combination)
        ? { combination: outcome.combination.verdict.reason }
        : {}),
      status: keepStatus ? prior.status : 'proposed',
      savedAt: now,
      statusChangedAt: keepStatus ? prior.statusChangedAt : now,
    };

    await write(artifactRoot, record);
    saved.push(record.id);
  }

  return saved;
}

/** Every ledger entry, optionally scoped to one workflow. */
export async function listProposals(
  artifactRoot: string,
  workflow?: string,
): Promise<ProposalRecord[]> {
  const records = await readAll(artifactRoot);
  return workflow ? records.filter(r => r.workflow === workflow) : records;
}

/** The ledger entry a command means, by id or unambiguous prefix. */
export async function findProposal(
  artifactRoot: string,
  target: string,
): Promise<ProposalRecord | undefined> {
  const records = await readAll(artifactRoot);
  const matches = records.filter(r => r.id === target || r.id.includes(target));
  return matches.length === 1 ? matches[0] : records.find(r => r.id === target);
}

/**
 * Move a proposal between statuses.
 *
 * Entering trial or applied checks the union of everything already in effect
 * for conflicts, because two accepted proposals claiming the same thing is
 * exactly the co-proposal problem the combination stage exists to measure —
 * the ledger refuses the state rather than letting the run path discover it.
 */
export async function setProposalStatus(
  artifactRoot: string,
  target: string,
  status: ProposalRecord['status'],
  extra?: Partial<Pick<ProposalRecord, 'inverse' | 'edit' | 'branch' | 'workspace' | 'prCommand' | 'diff'>>,
): Promise<{ record: ProposalRecord } | { error: string }> {
  const record = await findProposal(artifactRoot, target);
  if (!record) return { error: `no proposal matching '${target}'` };

  if (status === 'trial' || status === 'applied') {
    const inEffect = (await listProposals(artifactRoot, record.workflow))
      .filter(r => (r.status === 'trial' || r.status === 'applied') && r.id !== record.id);
    const conflicts = detectConflicts([...inEffect.flatMap(r => r.change), ...record.change]);
    if (conflicts.length > 0) {
      return { error: `entering ${status} would conflict with what is already in effect: ${conflicts.join('; ')}` };
    }
  }

  const next: ProposalRecord = { ...record, ...extra, status, statusChangedAt: new Date().toISOString() };
  await write(artifactRoot, next);
  return { record: next };
}

/**
 * Every change the trialled proposals of one workflow carry, with their ids.
 *
 * Trial only: an applied proposal lives in the source now, and overlaying it
 * as well would apply it twice.
 */
export async function trialChangesFor(
  artifactRoot: string,
  workflow: string,
): Promise<{ ids: string[]; changes: Change[] }> {
  const trialled = (await listProposals(artifactRoot, workflow)).filter(r => r.status === 'trial');
  return {
    ids: trialled.map(r => r.id),
    changes: trialled.flatMap(r => r.change),
  };
}

/** Where the last source write is recorded, under the artifact root. */
const EPOCH_FILE = '.epoch';

/**
 * Mark that the workflow source changed, which retires the recorded corpus.
 *
 * Runs, draws, and base prefixes recorded before a source write belong to a
 * workflow that no longer exists, and the readers that assume exchangeability
 * exclude anything older than this.
 */
export async function writeEpoch(artifactRoot: string): Promise<void> {
  await mkdir(join(artifactRoot, DIR), { recursive: true });
  await writeFile(join(artifactRoot, DIR, EPOCH_FILE), `${new Date().toISOString()}
`);
}

/** When the source last changed, or nothing when it never has. */
export async function readEpoch(artifactRoot: string): Promise<string | undefined> {
  try {
    const raw = (await readFile(join(artifactRoot, DIR, EPOCH_FILE), 'utf8')).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

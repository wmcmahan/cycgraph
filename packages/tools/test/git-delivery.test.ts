/**
 * Tests for the git delivery helpers (src/git/): publish config
 * resolution, PR-template filling, commit identity, and the shared
 * delivery nodes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  commit,
  DEFAULT_IDENTITY,
  deliveryNodes,
  fillSection,
  openPrFiles,
  prBodyFor,
  publishConfigFromEnv,
} from '../src/git/index.js';

const exec = promisify(execFile);

let root: string;

async function initRepo(at: string): Promise<void> {
  await exec('git', ['init', '--quiet', at]);
  await writeFile(join(at, 'seed.txt'), 'seed\n');
  await commit(at, 'seed');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-delivery-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('publishConfigFromEnv', () => {
  it('prefers GH_TOKEN over GITHUB_TOKEN', () => {
    const config = publishConfigFromEnv({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' });

    expect(config.token).toBe('a');
  });

  it('falls back to GITHUB_TOKEN', () => {
    expect(publishConfigFromEnv({ GITHUB_TOKEN: 'b' }).token).toBe('b');
  });

  it('resolves an identity only when both name and email are set', () => {
    const partial = publishConfigFromEnv({ GIT_AUTHOR_NAME: 'n' });
    const full = publishConfigFromEnv({ GIT_AUTHOR_NAME: 'n', GIT_AUTHOR_EMAIL: 'e@x' });

    expect(partial.identity).toBeUndefined();
    expect(full.identity).toEqual({ name: 'n', email: 'e@x' });
  });

  it('returns an empty config from an empty environment', () => {
    expect(publishConfigFromEnv({})).toEqual({});
  });
});

describe('fillSection', () => {
  const TEMPLATE = '## Summary\n\nplaceholder\n\n## Checklist\n\n- [ ] box\n';

  it('replaces the content under the named heading', () => {
    const filled = fillSection(TEMPLATE, 'Summary', 'the real summary');

    expect(filled).toContain('## Summary\n\nthe real summary\n');
    expect(filled).not.toContain('placeholder');
  });

  it('leaves other sections byte-identical', () => {
    const filled = fillSection(TEMPLATE, 'Summary', 'x');

    expect(filled).toContain('## Checklist\n\n- [ ] box\n');
  });

  it('returns the body unchanged when the heading is absent', () => {
    expect(fillSection(TEMPLATE, 'Nope', 'x')).toBe(TEMPLATE);
  });
});

describe('prBodyFor', () => {
  it('fills Summary and Changes from the repository template and appends provenance', async () => {
    await mkdir(join(root, '.github'), { recursive: true });
    await writeFile(
      join(root, '.github', 'PULL_REQUEST_TEMPLATE.md'),
      '## Summary\n\nBrief description.\n\n## Changes\n\n-\n\n## Test plan\n\n- [ ] tests pass\n',
    );

    const body = await prBodyFor(root, {
      summary: 'fixes one stale claim',
      changes: ['corrected db:migrate'],
      provenance: 'docs-maintenance run',
    });

    expect(body).toContain('## Summary\n\nfixes one stale claim\n');
    expect(body).toContain('## Changes\n\n- corrected db:migrate\n');
    expect(body).toContain('- [ ] tests pass');
    expect(body).toContain('## Provenance\n\ndocs-maintenance run');
    expect(body).not.toContain('Brief description.');
  });

  it('renders a plain body when the repository has no template', async () => {
    const body = await prBodyFor(root, { summary: 'just this', changes: ['one'] });

    expect(body).toBe('just this\n\n## Changes\n\n- one');
  });
});

describe('commit', () => {
  it('commits under the given identity', async () => {
    await exec('git', ['init', '--quiet', root]);
    await writeFile(join(root, 'a.txt'), 'a\n');

    await commit(root, 'message', { name: 'Custom Bot', email: 'bot@x.test' });

    const { stdout } = await exec('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root });
    expect(stdout.trim()).toBe('Custom Bot <bot@x.test>');
  });

  it('commits under the default identity when none is given', async () => {
    await exec('git', ['init', '--quiet', root]);
    await writeFile(join(root, 'a.txt'), 'a\n');

    await commit(root, 'message');

    const { stdout } = await exec('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root });
    expect(stdout.trim()).toBe(`${DEFAULT_IDENTITY.name} <${DEFAULT_IDENTITY.email}>`);
  });
});

describe('openPrFiles', () => {
  it('returns undefined when the PR list cannot be read', async () => {
    expect(await openPrFiles(root, 'docs/')).toBeUndefined();
  });
});

describe('deliveryNodes', () => {
  function build(overrides: Partial<Parameters<typeof deliveryNodes>[0]> = {}) {
    return deliveryNodes({
      repoRoot: root,
      workspaceAt: join(root, 'ws'),
      branch: 'delivery/test',
      title: 'test: change',
      detailFrom: 'judge_result',
      ...overrides,
    });
  }

  it('names the nodes clone, commit, and publish', () => {
    const delivery = build();

    expect(delivery.clone.id).toBe('clone');
    expect(delivery.commit.id).toBe('commit');
    expect(delivery.publish.id).toBe('publish');
  });

  it('clones the repository to the chosen path on its branch', async () => {
    await initRepo(root);
    const delivery = build({ workspaceAt: join(tmpdir(), `delivery-clone-${Date.now()}`) });

    const made = await delivery.clone.tools![0]!.execute({}) as { workspace: string; branch: string };

    const { stdout } = await exec('git', ['branch', '--show-current'], { cwd: made.workspace });
    expect(stdout.trim()).toBe('delivery/test');
    await rm(made.workspace, { recursive: true, force: true });
  });

  it('commits the workspace change with the verdict detail in the message', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-commit-${Date.now()}`);
    const delivery = build({ workspaceAt: at });
    await delivery.clone.tools![0]!.execute({});
    await writeFile(join(at, 'seed.txt'), 'changed\n');

    const result = await delivery.commit.tools![0]!.execute({
      judge_result: { detail: 'fixed the thing' },
    }) as { committed: boolean; diff: string; prCommand: string };

    const { stdout } = await exec('git', ['log', '-1', '--format=%B'], { cwd: at });
    expect(result.committed).toBe(true);
    expect(result.diff).toContain('-seed');
    expect(result.prCommand).toContain('gh pr create');
    expect(stdout).toContain('fixed the thing');
    await rm(at, { recursive: true, force: true });
  });

  it('skips the commit when commit is off and returns the diff for inspection', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-nocommit-${Date.now()}`);
    const delivery = build({ workspaceAt: at, commit: false });
    await delivery.clone.tools![0]!.execute({});
    await writeFile(join(at, 'seed.txt'), 'changed\n');

    const result = await delivery.commit.tools![0]!.execute({}) as { committed: boolean; diff: string };

    expect(result.committed).toBe(false);
    expect(result.diff).toContain('+changed');
    await rm(at, { recursive: true, force: true });
  });

  it('accumulates count, details, and the whole-branch diff across batch commits', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-batch-${Date.now()}`);
    const delivery = build({ workspaceAt: at });
    await delivery.clone.tools![0]!.execute({});
    const commitTool = delivery.commit.tools![0]!;

    await writeFile(join(at, 'seed.txt'), 'first\n');
    const first = await commitTool.execute({ judge_result: { detail: 'first fix' } }) as
      { count: number; details: string[] };
    await writeFile(join(at, 'other.txt'), 'second\n');
    const second = await commitTool.execute({
      judge_result: { detail: 'second fix' },
      commit_result: first,
    }) as { count: number; details: string[]; diff: string };

    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(second.details).toEqual(['first fix', 'second fix']);
    expect(second.diff).toContain('first');
    expect(second.diff).toContain('second');
    await rm(at, { recursive: true, force: true });
  });

  it('refuses to publish when nothing was committed', async () => {
    const delivery = build();

    const result = await delivery.publish.tools![0]!.execute({
      commit_result: { committed: false },
    }) as { published: boolean; detail: string };

    expect(result.published).toBe(false);
    expect(result.detail).toBe('nothing was committed');
  });

  it('reports publishing off without touching any remote', async () => {
    const delivery = build({ publish: false });

    const result = await delivery.publish.tools![0]!.execute({
      commit_result: { committed: true },
    }) as { published: boolean; detail: string };

    expect(result.published).toBe(false);
    expect(result.detail).toBe('publishing is off; the commit result carries the script');
  });
});

describe('issueMarkers', () => {
  it('recovers finding keys from issue bodies and ignores unmarked issues', async () => {
    const { findingMarker, issueMarkers } = await import('../src/git/issues.js');
    const issues = [
      { number: 1, title: 'a', body: `something\n${findingMarker('todo:x.ts:fix-me')}` },
      { number: 2, title: 'b', body: 'no marker here' },
      { number: 3, title: 'c', body: findingMarker('lint-warning:y.ts:rule') },
    ];

    const keys = issueMarkers(issues);

    expect(keys).toEqual(new Set(['todo:x.ts:fix-me', 'lint-warning:y.ts:rule']));
  });
});

describe('listOpenIssues', () => {
  it('returns undefined when the issue list cannot be read', async () => {
    const { listOpenIssues } = await import('../src/git/issues.js');

    expect(await listOpenIssues(root)).toBeUndefined();
  });
});

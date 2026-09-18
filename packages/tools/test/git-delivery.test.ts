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
  commentableDiffLines,
  commit,
  DEFAULT_IDENTITY,
  deliveryNodes,
  fillSection,
  openPrFiles,
  pendingDiff,
  prBodyFor,
  publishConfigFromEnv,
  tickCheckbox,
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

  it('applies ticks, not-applicable blocks, and closed issues to the template', async () => {
    await mkdir(join(root, '.github'), { recursive: true });
    await writeFile(
      join(root, '.github', 'PULL_REQUEST_TEMPLATE.md'),
      [
        '## Summary', '', 'Brief.', '',
        '## Test plan', '', '- [ ] tests pass', '- [ ] tested manually', '',
        '## Database', '', '- [ ] migration generated', '',
        '## Related issues', '', 'Closes #', '',
      ].join('\n'),
    );

    const body = await prBodyFor(root, {
      summary: 'the fix',
      closes: [220],
      ticks: [
        { match: 'tests pass', note: 'npm test ran clean' },
        { match: 'tested manually', checked: false, note: 'not performed' },
      ],
      notApplicable: [{ heading: 'Database', reason: 'no schema changes' }],
    });

    expect(body).toContain('- [x] tests pass — npm test ran clean');
    expect(body).toContain('- [ ] tested manually — not performed');
    expect(body).toContain('## Database\n\n_Not applicable — no schema changes._');
    expect(body).not.toContain('migration generated');
    expect(body).toContain('## Related issues\n\nCloses #220\n');
  });

  it('includes closed issues in the plain body when there is no template', async () => {
    const body = await prBodyFor(root, { summary: 'just this', closes: [7] });

    expect(body).toBe('just this\n\nCloses #7');
  });
});

describe('tickCheckbox', () => {
  const BODY = '## List\n\n- [ ] alpha check\n- [ ] beta check\n';

  it('ticks the matching line and appends the note', () => {
    const ticked = tickCheckbox(BODY, { match: 'beta', note: 'verified' });

    expect(ticked).toContain('- [x] beta check — verified');
    expect(ticked).toContain('- [ ] alpha check');
  });

  it('annotates without ticking when checked is false', () => {
    const ticked = tickCheckbox(BODY, { match: 'alpha', checked: false, note: 'not verified' });

    expect(ticked).toContain('- [ ] alpha check — not verified');
  });

  it('returns the body unchanged when no checkbox matches', () => {
    expect(tickCheckbox(BODY, { match: 'gamma' })).toBe(BODY);
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

describe('pendingDiff', () => {
  it('includes a modified tracked file', async () => {
    await initRepo(root);
    await writeFile(join(root, 'seed.txt'), 'changed\n');

    const diff = await pendingDiff(root);

    expect(diff).toContain('seed.txt');
    expect(diff).toContain('+changed');
  });

  it('includes a newly created untracked file', async () => {
    await initRepo(root);
    await writeFile(join(root, 'created.ts'), 'export const fresh = true;\n');

    const diff = await pendingDiff(root);

    expect(diff).toContain('created.ts');
    expect(diff).toContain('+export const fresh = true;');
  });
});

describe('openPrFiles', () => {
  it('returns undefined when the PR list cannot be read', { timeout: 30_000 }, async () => {
    expect(await openPrFiles(root, 'docs/')).toBeUndefined();
  });
});

describe('prFeedback', () => {
  it('returns undefined when the PR cannot be read', { timeout: 30_000 }, async () => {
    const { prFeedback } = await import('../src/git/pr.js');

    expect(await prFeedback(root, 999999)).toBeUndefined();
  });
});

describe('commentOnPr', () => {
  it('reports the failure when the comment cannot be posted', { timeout: 30_000 }, async () => {
    const { commentOnPr } = await import('../src/git/pr.js');

    const outcome = await commentOnPr(root, 999999, 'hello');

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.length).toBeGreaterThan(0);
  });
});

describe('pushBranch', () => {
  it('rejects when there is no remote to push to', async () => {
    await exec('git', ['init', '--quiet', root]);
    await writeFile(join(root, 'a.txt'), 'a\n');
    await commit(root, 'seed');
    const { pushBranch } = await import('../src/git/branch.js');

    await expect(pushBranch({ root, branch: 'main' }, root)).rejects.toThrow();
  });
});

describe('linkNestedModules', () => {
  async function seedWorkspaces(checkout: string, clone: string): Promise<void> {
    for (const base of [checkout, clone]) {
      await mkdir(join(base, 'packages', 'core'), { recursive: true });
      await mkdir(join(base, 'packages', 'dependent'), { recursive: true });
      await writeFile(join(base, 'packages', 'core', 'package.json'), '{"name":"@scope/core"}');
      await writeFile(join(base, 'packages', 'dependent', 'package.json'), '{"name":"@scope/dependent"}');
    }
  }

  it('resolves an internal package to the clone tree ahead of the root symlink', async () => {
    const checkout = join(root, 'checkout');
    const clone = join(root, 'clone');
    await seedWorkspaces(checkout, clone);
    await mkdir(join(checkout, 'node_modules', '@scope', 'core'), { recursive: true });
    await writeFile(join(checkout, 'node_modules', '@scope', 'core', 'package.json'),
      '{"name":"@scope/core","from":"checkout"}');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(checkout, 'node_modules'), join(clone, 'node_modules'));
    const { linkNestedModules } = await import('../src/git/branch.js');

    await linkNestedModules(checkout, clone);

    const { createRequire } = await import('node:module');
    const resolver = createRequire(join(clone, 'packages', 'dependent', 'index.js'));
    const resolved = resolver.resolve('@scope/core/package.json');
    const { readFileSync, realpathSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(resolved, 'utf8'))['from']).toBeUndefined();
    expect(realpathSync(resolved).startsWith(realpathSync(join(clone, 'packages', 'core')))).toBe(true);
  });

  it('refuses a manifest name that would link outside the clone', async () => {
    const checkout = join(root, 'checkout');
    const clone = join(root, 'clone');
    await seedWorkspaces(checkout, clone);
    await mkdir(join(clone, 'packages', 'evil'), { recursive: true });
    await writeFile(join(clone, 'packages', 'evil', 'package.json'), '{"name":"../../../escaped"}');
    const { linkNestedModules } = await import('../src/git/branch.js');

    await linkNestedModules(checkout, clone);

    const { existsSync, lstatSync } = await import('node:fs');
    expect(existsSync(join(root, 'escaped'))).toBe(false);
    expect(lstatSync(join(clone, 'packages', 'node_modules', '@scope', 'core')).isSymbolicLink()).toBe(true);
  });

  it('never writes through a group node_modules symlink into the checkout', async () => {
    const checkout = join(root, 'checkout');
    const clone = join(root, 'clone');
    await seedWorkspaces(checkout, clone);
    await mkdir(join(checkout, 'packages', 'node_modules', 'shared-dep'), { recursive: true });
    const { linkNestedModules } = await import('../src/git/branch.js');

    await linkNestedModules(checkout, clone);

    const { existsSync, lstatSync, realpathSync } = await import('node:fs');
    expect(existsSync(join(checkout, 'packages', 'node_modules', '@scope'))).toBe(false);
    expect(lstatSync(join(clone, 'packages', 'node_modules')).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(clone, 'packages', 'node_modules', 'shared-dep')))
      .toBe(realpathSync(join(checkout, 'packages', 'node_modules', 'shared-dep')));
    expect(realpathSync(join(clone, 'packages', 'node_modules', '@scope', 'core')))
      .toBe(realpathSync(join(clone, 'packages', 'core')));
  });

  it('still links nested node_modules from the checkout into the clone', async () => {
    const checkout = join(root, 'checkout');
    const clone = join(root, 'clone');
    await mkdir(join(checkout, 'packages', 'core', 'node_modules', 'dep'), { recursive: true });
    await mkdir(join(clone, 'packages', 'core'), { recursive: true });
    await writeFile(join(checkout, 'packages', 'core', 'package.json'), '{"name":"@scope/core"}');
    await writeFile(join(clone, 'packages', 'core', 'package.json'), '{"name":"@scope/core"}');
    const { linkNestedModules } = await import('../src/git/branch.js');

    await linkNestedModules(checkout, clone);

    const { realpathSync } = await import('node:fs');
    const linked = realpathSync(join(clone, 'packages', 'core', 'node_modules'));
    expect(linked).toBe(realpathSync(join(checkout, 'packages', 'core', 'node_modules')));
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

  it('commits under the change\'s own subject when the detail value carries one', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-subject-${Date.now()}`);
    const delivery = build({ workspaceAt: at });
    await delivery.clone.tools![0]!.execute({});
    await writeFile(join(at, 'seed.txt'), 'changed\n');

    const result = await delivery.commit.tools![0]!.execute({
      judge_result: { detail: 'fixed the thing', subject: 'fix: retriever drops fact ids' },
    }) as { subjects: string[]; prCommand: string };

    const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: at });
    expect(stdout.trim()).toBe('fix: retriever drops fact ids');
    expect(result.subjects).toEqual(['fix: retriever drops fact ids']);
    expect(result.prCommand).toContain('"fix: retriever drops fact ids"');
    await rm(at, { recursive: true, force: true });
  });

  it('keeps the stock title as the subject when the detail value carries none', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-stock-${Date.now()}`);
    const delivery = build({ workspaceAt: at });
    await delivery.clone.tools![0]!.execute({});
    await writeFile(join(at, 'seed.txt'), 'changed\n');

    await delivery.commit.tools![0]!.execute({ judge_result: { detail: 'fixed the thing' } });

    const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: at });
    expect(stdout.trim()).toBe('test: change');
    await rm(at, { recursive: true, force: true });
  });

  it('collapses a subject to one bounded line', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-longsubj-${Date.now()}`);
    const delivery = build({ workspaceAt: at });
    await delivery.clone.tools![0]!.execute({});
    await writeFile(join(at, 'seed.txt'), 'changed\n');

    await delivery.commit.tools![0]!.execute({
      judge_result: { detail: 'd', subject: `fix: ${'a'.repeat(100)}\nsecond line` },
    });

    const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: at });
    expect(stdout.trim()).toHaveLength(72);
    expect(stdout.trim().endsWith('…')).toBe(true);
    await rm(at, { recursive: true, force: true });
  });

  it('titles a multi-commit batch with the stock title, not one commit\'s subject', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-batchsubj-${Date.now()}`);
    const delivery = build({ workspaceAt: at });
    await delivery.clone.tools![0]!.execute({});
    const commitTool = delivery.commit.tools![0]!;

    await writeFile(join(at, 'seed.txt'), 'first\n');
    const first = await commitTool.execute({
      judge_result: { detail: 'first fix', subject: 'fix: first thing' },
    }) as { subjects: string[] };
    await writeFile(join(at, 'other.txt'), 'second\n');
    const second = await commitTool.execute({
      judge_result: { detail: 'second fix', subject: 'fix: second thing' },
      commit_result: first,
    }) as { subjects: string[]; prCommand: string };

    expect(second.subjects).toEqual(['fix: first thing', 'fix: second thing']);
    expect(second.prCommand).toContain('"test: change"');
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

describe('commentableDiffLines', () => {
  const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 0000000..1111111 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' context1',
    '-removed',
    '+added1',
    '+added2',
    ' context2',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -10,2 +10,3 @@',
    ' ctx',
    '+new',
    ' ctx2',
    '',
  ].join('\n');

  it('collects added and context new-file lines per path', () => {
    const lines = commentableDiffLines(DIFF);

    expect(lines.get('src/a.ts')).toEqual(new Set([1, 2, 3, 4]));
    expect(lines.get('src/b.ts')).toEqual(new Set([10, 11, 12]));
  });

  it('does not count removed lines against the new file', () => {
    const lines = commentableDiffLines(DIFF);

    expect(lines.get('src/a.ts')!.has(5)).toBe(false);
  });

  it('treats an added line starting with ++ as content, not a file header', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+++counter += 1',
      '',
    ].join('\n');

    const lines = commentableDiffLines(diff);

    expect([...lines.keys()]).toEqual(['x.ts']);
    expect(lines.get('x.ts')).toEqual(new Set([1, 2]));
  });

  it('counts a blank line with its leading space stripped as context', () => {
    const diff = [
      'diff --git a/y.ts b/y.ts',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '',
      '+three',
      '',
    ].join('\n');

    const lines = commentableDiffLines(diff);

    expect(lines.get('y.ts')).toEqual(new Set([1, 2, 3]));
  });

  it('returns an empty map for an empty diff', () => {
    expect(commentableDiffLines('').size).toBe(0);
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
  it('returns undefined when the issue list cannot be read', { timeout: 30_000 }, async () => {
    const { listOpenIssues } = await import('../src/git/issues.js');

    expect(await listOpenIssues(root)).toBeUndefined();
  });
});

describe('subject truncation', () => {
  it('truncates an overlong subject at a word boundary', async () => {
    await initRepo(root);
    const at = join(tmpdir(), `delivery-wordcut-${Date.now()}`);
    const delivery = deliveryNodes({
      repoRoot: root, workspaceAt: at, branch: 'delivery/test',
      title: 'test: change', detailFrom: 'judge_result',
    });
    await delivery.clone.tools![0]!.execute({});
    await writeFile(join(at, 'seed.txt'), 'changed\n');

    await delivery.commit.tools![0]!.execute({
      judge_result: { detail: 'd', subject: 'fix: the SSRF guard on agent card endpoints has no rebinding recheck at resolve time' },
    });

    const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: at });
    expect(stdout.trim()).toBe('fix: the SSRF guard on agent card endpoints has no rebinding recheck…');
    await rm(at, { recursive: true, force: true });
  });
});

describe('ghErrorDetail', () => {
  it('prefers the first non-empty stderr line over the exec message', async () => {
    const { ghErrorDetail } = await import('../src/git/pr.js');
    const error = Object.assign(new Error('Command failed: gh api x\ngh: HTTP 403'), {
      stderr: '\ngh: Resource not accessible by personal access token (HTTP 403)\n',
    });

    expect(ghErrorDetail(error)).toBe('gh: Resource not accessible by personal access token (HTTP 403)');
  });

  it('falls back to the first message line when stderr is absent', async () => {
    const { ghErrorDetail } = await import('../src/git/pr.js');

    expect(ghErrorDetail(new Error('Command failed: gh api x\ndetail'))).toBe('Command failed: gh api x');
  });

  it('stringifies a non-Error value', async () => {
    const { ghErrorDetail } = await import('../src/git/pr.js');

    expect(ghErrorDetail('plain failure')).toBe('plain failure');
  });

  it('caps the detail at 400 characters', async () => {
    const { ghErrorDetail } = await import('../src/git/pr.js');
    const error = Object.assign(new Error('x'), { stderr: 'e'.repeat(500) });

    expect(ghErrorDetail(error)).toHaveLength(400);
  });
});

describe('ghErrorDetail stdout body', () => {
  it('prefers the API message from the stdout JSON body', async () => {
    const { ghErrorDetail } = await import('../src/git/pr.js');
    const error = Object.assign(new Error('Command failed: gh api x'), {
      stdout: '{"message":"Can not approve your own pull request","documentation_url":"x"}',
      stderr: 'gh: Unprocessable Entity (HTTP 422)',
    });

    expect(ghErrorDetail(error)).toBe('Can not approve your own pull request');
  });

  it('appends the errors array when the body carries one', async () => {
    const { ghErrorDetail } = await import('../src/git/pr.js');
    const error = Object.assign(new Error('x'), {
      stdout: '{"message":"Unprocessable Entity","errors":[{"resource":"PullRequestReviewThread","field":"line"}]}',
    });

    expect(ghErrorDetail(error)).toBe('Unprocessable Entity — [{"resource":"PullRequestReviewThread","field":"line"}]');
  });

  it('falls back to stderr when stdout is not JSON', async () => {
    const { ghErrorDetail } = await import('../src/git/pr.js');
    const error = Object.assign(new Error('x'), {
      stdout: 'not json',
      stderr: 'gh: HTTP 403',
    });

    expect(ghErrorDetail(error)).toBe('gh: HTTP 403');
  });
});

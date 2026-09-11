import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGitEntry, discoverRepos } from './discover.js';
import type { Config } from '../config.js';

function config(overrides: Partial<Config>): Config {
  return {
    roots: [], ignore: [], pruneDirs: ['node_modules', '.git'], maxDepth: 5,
    includeHidden: false, scanInsideRepos: true, followSymlinks: false,
    concurrency: 4, editor: 'true', cacheTtlSeconds: 0, repos: {},
    ...overrides,
  };
}

async function sandbox(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'repo-dash-disc-')));
}

/** Builds a working directory whose `.git` is a pointer file. */
async function pointerRepo(root: string, name: string, gitdir: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
  return dir;
}

test('a submodule is not reported as a worktree', async () => {
  // Regression: both are `.git` pointer files, so submodules were mislabeled.
  const root = await sandbox();
  const sub = await pointerRepo(root, 'sub', '../.git/modules/sub');
  const wt = await pointerRepo(root, 'wt', '/abs/parent/.git/worktrees/wt');
  const broken = await pointerRepo(root, 'broken', '');

  assert.equal(await classifyGitEntry(sub, true), 'submodule');
  assert.equal(await classifyGitEntry(wt, true), 'worktree');
  assert.equal(await classifyGitEntry(broken, true), 'linked');
});

test('nested worktree and submodule markers resolve to the innermost kind', async () => {
  // Regression: git writes .git/worktrees/<wt>/modules/<sub> for a submodule
  // added inside a linked worktree, and .git/modules/<sub>/worktrees/<wt> for
  // a worktree created inside a submodule. The last marker decides.
  const root = await sandbox();
  const cases: Array<[string, string, string]> = [
    ['plain-wt', '/p/.git/worktrees/wt', 'worktree'],
    ['sub-in-wt', '../../p/.git/worktrees/wt/modules/sub', 'submodule'],
    ['plain-sub', '../.git/modules/sub', 'submodule'],
    ['wt-of-sub', '/p/.git/modules/sub/worktrees/wt', 'worktree'],
    ['unknown', '/somewhere/else', 'linked'],
  ];
  for (const [name, gitdir, expected] of cases) {
    const dir = await pointerRepo(root, name, gitdir);
    assert.equal(await classifyGitEntry(dir, true), expected, `${name} -> ${gitdir}`);
  }
});

test('a .git directory is a normal repo', async () => {
  const root = await sandbox();
  const dir = join(root, 'plain');
  await mkdir(join(dir, '.git'), { recursive: true });
  assert.equal(await classifyGitEntry(dir, false), 'normal');
});

test('discovery reports the repo kind', async () => {
  const root = await sandbox();
  await pointerRepo(root, 'sub', '../.git/modules/sub');
  await mkdir(join(root, 'plain', '.git'), { recursive: true });

  const { repos } = await discoverRepos(config({ roots: [{ path: root }] }));
  const kinds = Object.fromEntries(repos.map((r) => [r.name, r.kind]));
  assert.deepEqual(kinds, { plain: 'normal', sub: 'submodule' });
});

test('a symlink cycle yields each repo once', async () => {
  // Regression: `loop -> .` produced one result per depth level.
  const root = await sandbox();
  await mkdir(join(root, 'realrepo', '.git'), { recursive: true });
  await symlink('.', join(root, 'loop'));

  const { repos } = await discoverRepos(
    config({ roots: [{ path: root, maxDepth: 5 }], followSymlinks: true }),
  );
  assert.equal(repos.length, 1, `expected 1 repo, got ${repos.map((r) => r.path).join(', ')}`);
  assert.equal(repos[0]?.name, 'realrepo');
});

test('hidden overrides and ignore patterns remove repos', async () => {
  const root = await sandbox();
  await mkdir(join(root, 'keep', '.git'), { recursive: true });
  await mkdir(join(root, 'drop', '.git'), { recursive: true });
  await mkdir(join(root, 'skipme', '.git'), { recursive: true });

  const cfg = config({
    roots: [{ path: root }],
    ignore: ['**/skipme'],
    repos: { [join(root, 'drop')]: { hidden: true } },
  });
  const { repos } = await discoverRepos(cfg);
  assert.deepEqual(repos.map((r) => r.name), ['keep']);
});

test('missing roots are reported, not fatal', async () => {
  const root = await sandbox();
  await mkdir(join(root, 'here', '.git'), { recursive: true });
  const { repos, missingRoots } = await discoverRepos(
    config({ roots: [{ path: root }, { path: join(root, 'nope') }] }),
  );
  assert.deepEqual(repos.map((r) => r.name), ['here']);
  assert.equal(missingRoots.length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit, gitConcurrency } from './exec.js';
import { discoverRepos } from './discover.js';
import { buildGroups } from './snapshot.js';
import type { Config } from '../config.js';

function config(root: string): Config {
  return {
    roots: [{ path: root }], ignore: [], pruneDirs: ['node_modules', '.git'], maxDepth: 4,
    includeHidden: false, scanInsideRepos: true, followSymlinks: false,
    concurrency: 4, editor: 'true', cacheTtlSeconds: 0, repos: {},
  };
}

async function sandbox(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'repo-dash-snap-')));
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await runGit(dir, ['init', '-q', '-b', 'main']);
  await runGit(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
}

async function groupsFor(root: string) {
  const cfg = config(root);
  const { repos } = await discoverRepos(cfg);
  return buildGroups(repos, cfg);
}

test('a linked worktree is nested under its repo, not listed separately', async () => {
  // Discovery finds two directories with a .git entry; they are one repository.
  const root = await sandbox();
  await initRepo(join(root, 'app'));
  await runGit(join(root, 'app'), ['worktree', 'add', '-q', join(root, 'app-feature'), '-b', 'feature/x']);

  const { repos } = await discoverRepos(config(root));
  assert.equal(repos.length, 2, 'both directories are discovered');

  const groups = await groupsFor(root);
  assert.equal(groups.length, 1, 'but they form one group');
  assert.equal(groups[0]?.name, 'app');
  assert.equal(groups[0]?.worktrees.length, 1);
  assert.equal(groups[0]?.worktrees[0]?.branch, 'feature/x');
});

test('worktree status is read independently of its parent', async () => {
  const root = await sandbox();
  await initRepo(join(root, 'app'));
  await runGit(join(root, 'app'), ['worktree', 'add', '-q', join(root, 'wt'), '-b', 'b']);
  await writeFile(join(root, 'wt', 'new.txt'), 'x', 'utf8');

  const groups = await groupsFor(root);
  assert.equal(groups[0]?.status?.dirty, 0, 'parent is clean');
  assert.equal(groups[0]?.worktrees[0]?.status?.untracked, 1, 'worktree has one untracked file');
});

test('a submodule stays its own group', async () => {
  const root = await sandbox();
  await initRepo(join(root, 'child'));
  await initRepo(join(root, 'parent'));
  await runGit(join(root, 'parent'), [
    '-c', 'protocol.file.allow=always', '-c', 'user.email=t@t', '-c', 'user.name=t',
    'submodule', 'add', '-q', join(root, 'child'), 'sub',
  ]);

  const groups = await groupsFor(root);
  const names = groups.map((g) => g.name).sort();
  assert.deepEqual(names, ['child', 'parent', 'sub']);
  assert.equal(groups.find((g) => g.name === 'sub')?.kind, 'submodule');
  assert.equal(groups.find((g) => g.name === 'parent')?.worktrees.length, 0);
});

test('an unrelated repository forms its own group', async () => {
  const root = await sandbox();
  await initRepo(join(root, 'one'));
  await initRepo(join(root, 'two'));
  const groups = await groupsFor(root);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0]?.commonDir, groups[1]?.commonDir);
});

test('a repository with no commits reports a branch but no last commit', async () => {
  const root = await sandbox();
  await mkdir(join(root, 'fresh'), { recursive: true });
  await runGit(join(root, 'fresh'), ['init', '-q', '-b', 'main']);

  const groups = await groupsFor(root);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.status?.branch, 'main');
  assert.equal(groups[0]?.status?.oid, null);
  assert.equal(groups[0]?.lastCommit, null);
});

test('a root reached through a symlink still matches its git-reported path', async () => {
  // Regression: git reports canonical paths, so a symlinked root left the main
  // worktree unmatched, labelled external, and read a second time.
  const root = await sandbox();
  await mkdir(join(root, 'real'), { recursive: true });
  await initRepo(join(root, 'real', 'app'));
  await runGit(join(root, 'real', 'app'), [
    'worktree', 'add', '-q', join(root, 'real', 'app-wt'), '-b', 'wtb',
  ]);
  await symlink(join(root, 'real'), join(root, 'alias'));

  const groups = await groupsFor(join(root, 'alias'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.discovered, true, 'main worktree should be recognised, not external');
  assert.equal(groups[0]?.worktrees.length, 1);
  assert.ok(groups[0]?.path.includes('/alias/'), 'the configured path is preserved for display');
});

test('git subprocesses respect the configured concurrency', async () => {
  const root = await sandbox();
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await initRepo(join(root, name));

  const cfg = config(root);
  cfg.concurrency = 2;
  const { repos } = await discoverRepos(cfg);
  await buildGroups(repos, cfg);
  assert.equal(gitConcurrency(), 2, 'buildGroups applies the configured limit to the shared git limiter');
});

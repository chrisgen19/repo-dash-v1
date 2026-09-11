import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteEnv, runGit } from './exec.js';
import { fetchRepo, fetchRepos, readFetchedAt } from './fetch.js';
import { readStatus } from './status.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

/** A bare remote, a clone of it under test, and a second clone that pushes. */
async function remoteAndClone(): Promise<{ root: string; app: string; pusher: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repo-dash-fetch-')));
  const remote = join(root, 'remote.git');
  const app = join(root, 'app');
  const pusher = join(root, 'pusher');
  await runGit(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await runGit(root, ['clone', '-q', remote, pusher]);
  await runGit(pusher, [...ID, 'commit', '-q', '--allow-empty', '-m', 'one']);
  await runGit(pusher, ['push', '-q', 'origin', 'HEAD:main']);
  await runGit(root, ['clone', '-q', remote, app]);
  return { root, app, pusher };
}

test('a fetch brings in new remote commits and records when it ran', async () => {
  const { app, pusher } = await remoteAndClone();
  const commonDir = join(app, '.git');
  assert.equal(await readFetchedAt(commonDir), null, 'a fresh clone has not fetched');

  await runGit(pusher, [...ID, 'commit', '-q', '--allow-empty', '-m', 'two']);
  await runGit(pusher, ['push', '-q', 'origin', 'HEAD:main']);
  assert.equal((await readStatus(app))?.behind, 0, 'behind is stale until a fetch');

  assert.deepEqual(await fetchRepo(app), { path: app, error: null });
  assert.equal((await readStatus(app))?.behind, 1, 'the fetch revealed the new commit');
  const at = await readFetchedAt(commonDir);
  assert.ok(at !== null && Math.abs(Date.now() / 1000 - at) < 60, `fetchedAt was ${at}`);
});

test('a fetch run only from a linked worktree still counts', async () => {
  // Git writes FETCH_HEAD under worktrees/<name>/ here and leaves the main
  // one absent, so reading only the main file would report "never".
  const { root, app } = await remoteAndClone();
  const wt = join(root, 'app-wt');
  await runGit(app, ['worktree', 'add', '-q', wt, '-b', 'wtb']);
  assert.equal((await fetchRepo(wt)).error, null);
  assert.notEqual(await readFetchedAt(join(app, '.git')), null);
});

test('a failing fetch is reported, not thrown', async () => {
  const { app } = await remoteAndClone();
  await runGit(app, ['remote', 'set-url', 'origin', join(app, 'no-such-remote.git')]);
  const result = await fetchRepo(app);
  assert.equal(result.path, app);
  assert.ok(result.error !== null && result.error.length > 0, 'the reason is kept');
});

test('fetchRepos reports progress for each repository', async () => {
  const a = await remoteAndClone();
  const b = await remoteAndClone();
  const seen: Array<[number, number]> = [];
  const results = await fetchRepos([a.app, b.app], 2, (done, total) => seen.push([done, total]));
  assert.deepEqual(results.map((r) => r.error), [null, null]);
  assert.deepEqual(seen.map(([, total]) => total), [2, 2]);
  assert.deepEqual(seen.map(([done]) => done).sort(), [1, 2]);
});

test('remote commands cannot prompt for credentials', async () => {
  const env = await remoteEnv();
  assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
  assert.equal(env['GIT_OPTIONAL_LOCKS'], '0', 'the usual isolation still applies');
});

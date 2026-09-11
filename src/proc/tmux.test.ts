import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capturePane, killSession, listSessions, sessionName, startSession, tmuxAvailable,
} from './tmux.js';
import { readDevStates, startDev, stopDev, restartDev } from './dev.js';
import type { Config } from '../config.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    roots: [], ignore: [], pruneDirs: [], maxDepth: 4, includeHidden: false,
    scanInsideRepos: true, followSymlinks: false, concurrency: 4, editor: 'true',
    cacheTtlSeconds: 0, repos: {}, ...overrides,
  };
}

test('a session name is tmux-safe and unique per path', () => {
  // tmux reads "." and ":" as address separators.
  const name = sessionName('/home/me/my.repo:v2');
  assert.ok(!name.includes('.') && !name.includes(':'), name);
  assert.match(name, /^rd_/);
  assert.notEqual(sessionName('/a/app'), sessionName('/b/app'), 'same name, different paths');
  assert.equal(sessionName('/a/app'), sessionName('/a/app'), 'stable for one path');
});

/** A repository whose dev script starts a server on `port`. */
async function devFixture(port: number): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'repo-dash-tmux-')), 'app');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }), 'utf8');
  await writeFile(
    join(dir, 'server.js'),
    `require('http').createServer((_, r) => r.end('ok')).listen(${port});\n`,
    'utf8',
  );
  await writeFile(join(dir, 'package-lock.json'), '{}', 'utf8');
  return dir;
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a dev server starts, reports its port, and stops', async (t) => {
  if (!(await tmuxAvailable())) return t.skip('tmux not installed');

  const dir = await devFixture(39187);
  const cfg = config();
  try {
    assert.equal(await startDev(dir, cfg), null);
    await settle(2500);

    const running = (await readDevStates([dir], cfg)).states.get(dir);
    assert.equal(running?.running, true);
    assert.deepEqual(running?.ports, [39187], 'the port is found through the process tree');

    assert.equal(await startDev(dir, cfg), 'already running', 'starting twice is refused');
    assert.equal(await stopDev(dir), null);

    const stopped = (await readDevStates([dir], cfg)).states.get(dir);
    assert.equal(stopped?.running, false);
    assert.deepEqual(stopped?.ports, []);
    assert.equal(await stopDev(dir), 'not running');
  } finally {
    await killSession(sessionName(dir));
  }
});

test('restart replaces a running session', async (t) => {
  if (!(await tmuxAvailable())) return t.skip('tmux not installed');

  const dir = await devFixture(39188);
  const cfg = config();
  try {
    await startDev(dir, cfg);
    await settle(1500);
    const before = (await listSessions()).get(sessionName(dir));

    assert.equal(await restartDev(dir, cfg), null);
    await settle(1500);
    const after = (await listSessions()).get(sessionName(dir));

    assert.ok(after !== undefined, 'still running after a restart');
    assert.notEqual(after?.panePid, before?.panePid, 'it is a new process');
  } finally {
    await killSession(sessionName(dir));
  }
});

test('a repository with nothing to run is reported, not started', async (t) => {
  if (!(await tmuxAvailable())) return t.skip('tmux not installed');
  const dir = await mkdtemp(join(tmpdir(), 'repo-dash-nodev-'));
  assert.equal(await startDev(dir, config()), 'no package.json');
  const state = (await readDevStates([dir], config())).states.get(dir);
  assert.equal(state?.available, false);
  assert.equal(state?.reason, 'no package.json');
});

test('pane output can be read back', async (t) => {
  if (!(await tmuxAvailable())) return t.skip('tmux not installed');
  const name = sessionName(`/tmp/capture-${process.pid}`);
  try {
    assert.equal(await startSession(name, tmpdir(), ['sh', '-c', 'echo hello-from-pane; sleep 30']), null);
    await settle(800);
    assert.match(await capturePane(name, 20), /hello-from-pane/);
  } finally {
    await killSession(name);
  }
});

test('starting with no command is refused', async () => {
  assert.equal(await startSession('rd_unused', tmpdir(), []), 'no command to run');
});

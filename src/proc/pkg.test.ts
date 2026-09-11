import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, resolveDevCommand } from './pkg.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-dash-pkg-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

const manifest = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'x', scripts: { dev: 'vite' }, ...extra });

test('the packageManager field wins over lockfiles', async () => {
  const dir = await fixture({
    'package.json': manifest({ packageManager: 'pnpm@9.0.0' }),
    'package-lock.json': '{}',
  });
  assert.equal(await detectPackageManager(dir, JSON.parse(manifest({ packageManager: 'pnpm@9.0.0' }))), 'pnpm');
});

test('lockfiles identify the manager', async () => {
  for (const [file, expected] of [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'], ['package-lock.json', 'npm'],
  ] as Array<[string, string]>) {
    const dir = await fixture({ 'package.json': manifest(), [file]: '' });
    assert.equal(await detectPackageManager(dir, null), expected, file);
  }
});

test('npm needs "run" while the others take the script directly', async () => {
  const npm = await fixture({ 'package.json': manifest(), 'package-lock.json': '' });
  assert.deepEqual((await resolveDevCommand(npm, undefined)).argv, ['npm', 'run', 'dev']);

  const pnpm = await fixture({ 'package.json': manifest(), 'pnpm-lock.yaml': '' });
  assert.deepEqual((await resolveDevCommand(pnpm, undefined)).argv, ['pnpm', 'dev']);
});

test('script names are tried in order', async () => {
  const dir = await fixture({ 'package.json': JSON.stringify({ scripts: { serve: 'x', start: 'y' } }) });
  assert.equal((await resolveDevCommand(dir, undefined)).script, 'start', 'start beats serve');
});

test('a repository with nothing to run explains why', async () => {
  const none = await fixture({});
  assert.deepEqual(await resolveDevCommand(none, undefined), {
    argv: [], reason: 'no package.json', packageManager: null, script: null,
  });

  const noScripts = await fixture({ 'package.json': JSON.stringify({ name: 'x' }) });
  assert.equal((await resolveDevCommand(noScripts, undefined)).reason, 'no scripts');

  const noDev = await fixture({ 'package.json': JSON.stringify({ scripts: { build: 'x' } }) });
  assert.equal((await resolveDevCommand(noDev, undefined)).reason, 'no dev script');
});

test('overrides replace detection', async () => {
  const dir = await fixture({ 'package.json': manifest(), 'package-lock.json': '' });
  const custom = await resolveDevCommand(dir, { devCommand: 'pnpm dev --port 4000' });
  assert.deepEqual(custom.argv, ['sh', '-c', 'pnpm dev --port 4000']);

  const forced = await resolveDevCommand(dir, { packageManager: 'yarn' });
  assert.deepEqual(forced.argv, ['yarn', 'dev']);

  const named = await fixture({ 'package.json': JSON.stringify({ scripts: { watch: 'x' } }) });
  assert.deepEqual((await resolveDevCommand(named, { devScript: 'watch' })).argv, ['npm', 'run', 'watch']);
  assert.equal((await resolveDevCommand(named, { devScript: 'missing' })).reason, 'no "missing" script');
});

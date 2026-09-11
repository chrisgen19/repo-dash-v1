import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOverrideIndex } from './overrides.js';
import type { Config } from '../config.js';

function config(repos: Config['repos']): Config {
  return {
    roots: [], ignore: [], pruneDirs: [], maxDepth: 4, includeHidden: false,
    scanInsideRepos: true, followSymlinks: false, concurrency: 4, editor: 'true',
    cacheTtlSeconds: 0, repos,
  };
}

/** A real directory plus a symlink to it, so canonicalisation has something to do. */
async function linked(): Promise<{ real: string; alias: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repo-dash-ovr-')));
  await mkdir(join(root, 'real', 'app'), { recursive: true });
  await symlink(join(root, 'real'), join(root, 'alias'));
  return { real: join(root, 'real', 'app'), alias: join(root, 'alias', 'app') };
}

test('an override keyed canonically applies to the symlinked path', async () => {
  // Regression: the dev layer looked up cfg.repos[path] directly, so an
  // override was silently ignored for a repo discovered through a symlink.
  const { real, alias } = await linked();
  const index = await buildOverrideIndex(config({ [real]: { devCommand: 'custom' } }));
  assert.equal((await index.lookup(alias))?.devCommand, 'custom');
  assert.equal((await index.lookup(real))?.devCommand, 'custom');
});

test('an override keyed by the symlinked path applies canonically', async () => {
  const { real, alias } = await linked();
  const index = await buildOverrideIndex(config({ [alias]: { devCommand: 'custom' } }));
  assert.equal((await index.lookup(real))?.devCommand, 'custom');
});

test('hidden is read through the same matching', async () => {
  const { real, alias } = await linked();
  const index = await buildOverrideIndex(config({ [real]: { hidden: true } }));
  assert.equal(await index.isHidden(alias), true);
  assert.equal(await index.isHidden(join(real, '..', 'other')), false);
});

test('an empty override map matches nothing', async () => {
  const index = await buildOverrideIndex(config({}));
  assert.equal(await index.lookup('/anything'), undefined);
  assert.equal(await index.isHidden('/anything'), false);
});

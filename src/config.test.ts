import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, normalizeRoots, saveConfig, configPath, expandPath } from './config.js';

/** Points config resolution at a throwaway directory for one callback. */
async function withTempConfigHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.env['XDG_CONFIG_HOME'];
  const dir = await mkdtemp(join(tmpdir(), 'repo-dash-cfg-'));
  process.env['XDG_CONFIG_HOME'] = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = previous;
  }
}

test('normalizeRoots rejects malformed entries', () => {
  // Regression: a null entry used to crash discovery reading `r.enabled`.
  assert.throws(() => normalizeRoots([null]), /roots\[0\]/);
  assert.throws(() => normalizeRoots([{ maxDepth: 2 }]), /missing a "path"/);
  assert.throws(() => normalizeRoots([{ path: '' }]), /missing a "path"/);
  assert.throws(() => normalizeRoots('nope'), /must be an array/);
});

test('normalizeRoots accepts strings and objects', () => {
  assert.deepEqual(normalizeRoots(['~/a']), [{ path: '~/a' }]);
  assert.deepEqual(
    normalizeRoots([{ path: '~/b', maxDepth: 2, enabled: false, label: 'work', junk: 1 }]),
    [{ path: '~/b', maxDepth: 2, enabled: false, label: 'work' }],
  );
});

test('a config omitting roots is seeded, not left empty', async () => {
  // Regression: `{"ignore":[]}` used to produce roots: [] and scan nothing.
  await withTempConfigHome(async (dir) => {
    await mkdir(join(dir, 'repo-dash'), { recursive: true });
    await writeFile(join(dir, 'repo-dash', 'config.json'), '{"ignore":[]}', 'utf8');
    const cfg = await loadConfig();
    assert.ok(cfg.roots.length > 0, 'omitted roots should fall back to the seed');
  });
});

test('an explicit empty roots array is honoured', async () => {
  await withTempConfigHome(async (dir) => {
    await mkdir(join(dir, 'repo-dash'), { recursive: true });
    await writeFile(join(dir, 'repo-dash', 'config.json'), '{"roots":[]}', 'utf8');
    const cfg = await loadConfig();
    assert.equal(cfg.roots.length, 0);
  });
});

test('invalid JSON and bad roots name the config file', async () => {
  await withTempConfigHome(async (dir) => {
    const file = join(dir, 'repo-dash', 'config.json');
    await mkdir(join(dir, 'repo-dash'), { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    await assert.rejects(loadConfig, /is not valid JSON/);
    await writeFile(file, '{"roots":[null]}', 'utf8');
    await assert.rejects(loadConfig, /roots\[0\]/);
  });
});

test('saveConfig leaves no temp file behind and round-trips', async () => {
  await withTempConfigHome(async (dir) => {
    const cfg = await loadConfig();
    cfg.roots = [{ path: '~/only', maxDepth: 1 }];
    await saveConfig(cfg);

    const entries = await readdir(join(dir, 'repo-dash'));
    assert.deepEqual(entries, ['config.json'], 'temp file should be renamed, not left');

    const text = await readFile(configPath(), 'utf8');
    assert.equal(JSON.parse(text).roots[0].path, '~/only');
    assert.deepEqual((await loadConfig()).roots, [{ path: '~/only', maxDepth: 1 }]);
  });
});

test('expandPath resolves ~ and environment variables', () => {
  process.env['RD_TEST_DIR'] = '/tmp/rd-test';
  assert.equal(expandPath('$RD_TEST_DIR/x'), '/tmp/rd-test/x');
  assert.equal(expandPath('${RD_TEST_DIR}'), '/tmp/rd-test');
  assert.ok(expandPath('~/x').startsWith('/'));
  delete process.env['RD_TEST_DIR'];
});

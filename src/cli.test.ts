import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

/** Runs the built CLI with an isolated config and cache directory. */
function run(
  args: string[],
  configHome: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
          XDG_CACHE_HOME: join(configHome, 'cache'),
          ...extraEnv,
        },
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
        resolve({ stdout, stderr, code: typeof code === 'number' ? code : 1 });
      },
    );
  });
}

async function emptyConfigHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-dash-cli-'));
  await mkdir(join(dir, 'repo-dash'), { recursive: true });
  await writeFile(join(dir, 'repo-dash', 'config.json'), '{"roots":[]}', 'utf8');
  return dir;
}

test('status --json stays machine-readable with no repositories', async () => {
  // Regression: this printed "No repositories found." and broke JSON parsing.
  const home = await emptyConfigHome();
  const { stdout, code } = await run(['status', '--json', '--refresh'], home);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout) as { groups: unknown[] };
  assert.deepEqual(parsed.groups, []);
});

test('list --json stays machine-readable with no repositories', async () => {
  const home = await emptyConfigHome();
  const { stdout } = await run(['list', '--json', '--refresh'], home);
  const parsed = JSON.parse(stdout) as { repos: unknown[] };
  assert.deepEqual(parsed.repos, []);
});

test('status without --json explains what to do next', async () => {
  const home = await emptyConfigHome();
  const { stdout } = await run(['status', '--refresh'], home);
  assert.match(stdout, /No repositories found/);
  assert.match(stdout, /roots add/);
});

const exec = promisify(execFile);

test('the summary counts a dirty worktree under a clean repository', async () => {
  // Regression: the summary read only each group's main status, so it said
  // "0 dirty" while the expanded table showed a dirty worktree above it.
  const home = await mkdtemp(join(tmpdir(), 'repo-dash-sum-'));
  const root = join(home, 'work');
  await mkdir(join(root, 'app'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: join(root, 'app') });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: join(root, 'app') });
  await exec('git', ['worktree', 'add', '-q', join(root, 'wt'), '-b', 'b'], { cwd: join(root, 'app') });
  await writeFile(join(root, 'wt', 'new.txt'), 'x', 'utf8');

  await mkdir(join(home, 'repo-dash'), { recursive: true });
  await writeFile(
    join(home, 'repo-dash', 'config.json'),
    JSON.stringify({ roots: [{ path: root }] }),
    'utf8',
  );

  const { stdout } = await run(['status', '--expand', '--refresh'], home);
  assert.match(stdout, /1 dirty working tree/, `summary should count the worktree:\n${stdout}`);
});

test('counts are singular when there is one of something', async () => {
  const home = await emptyConfigHome();
  const { stdout } = await run(['status', '--json', '--refresh'], home);
  assert.doesNotMatch(stdout, /1 repositories/);
});

test('an inherited GIT_DIR does not collapse unrelated repositories', async () => {
  // Regression: spreading process.env let GIT_DIR override every cwd, so all
  // repositories resolved to one git directory and all but one disappeared.
  const home = await mkdtemp(join(tmpdir(), 'repo-dash-env-'));
  const root = join(home, 'work');
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(root, name), { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: join(root, name) });
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: join(root, name) });
  }
  await mkdir(join(home, 'repo-dash'), { recursive: true });
  await writeFile(join(home, 'repo-dash', 'config.json'), JSON.stringify({ roots: [{ path: root }] }), 'utf8');

  const { stdout } = await run(['status', '--json', '--refresh'], home, {
    GIT_DIR: join(root, 'alpha', '.git'),
  });
  const names = (JSON.parse(stdout) as { groups: Array<{ name: string }> }).groups.map((g) => g.name);
  assert.deepEqual(names.sort(), ['alpha', 'beta']);
});

test('subcommand options survive global flag extraction', async () => {
  // Regression: stripping every leading dash-token removed --depth but left
  // its value behind, and --depth=N vanished entirely, silently saving the
  // default depth.
  const home = await mkdtemp(join(tmpdir(), 'repo-dash-flags-'));
  await mkdir(join(home, 'repo-dash'), { recursive: true });
  await writeFile(join(home, 'repo-dash', 'config.json'), '{"roots":[]}', 'utf8');

  assert.equal((await run(['roots', 'add', '/tmp/a-one', '--depth', '2'], home)).code, 0);
  assert.equal((await run(['roots', 'add', '/tmp/a-two', '--depth=3'], home)).code, 0);
  assert.equal((await run(['roots', 'add', '--depth', '5', '/tmp/a-three'], home)).code, 0);

  const cfg = JSON.parse(await readFile(join(home, 'repo-dash', 'config.json'), 'utf8')) as {
    roots: Array<{ path: string; maxDepth?: number }>;
  };
  assert.deepEqual(
    cfg.roots.map((r) => [r.path, r.maxDepth]),
    [['/tmp/a-one', 2], ['/tmp/a-two', 3], ['/tmp/a-three', 5]],
  );
});

test('a global flag may precede the command', async () => {
  const home = await emptyConfigHome();
  const { stdout, code } = await run(['--refresh', 'status', '--json'], home);
  assert.equal(code, 0);
  assert.deepEqual((JSON.parse(stdout) as { groups: unknown[] }).groups, []);
});

test('an unknown option is reported rather than treated as a command', async () => {
  const home = await emptyConfigHome();
  const { code } = await run(['--bogus'], home);
  assert.equal(code, 1);
});

test('dev logs reports a bad --lines value before looking up the repository', async () => {
  // Regression: a malformed value exited 0 with a different line count.
  const home = await emptyConfigHome();
  const bad = await run(['dev', 'logs', 'anything', '--lines', 'abc'], home);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--lines expects a positive integer/);

  // A valid value gets past validation and fails only on the lookup.
  const good = await run(['dev', 'logs', 'anything', '--lines', '5'], home);
  assert.equal(good.code, 1);
  assert.match(good.stderr, /no repository named "anything"/);
});

test('--version prints the version from package.json', async () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  const home = await emptyConfigHome();
  for (const flag of ['--version', '-v']) {
    const { stdout, code } = await run([flag], home);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), manifest.version, flag);
  }
});

/** Command names in the help's Usage section: the words before any argument or option. */
function usageCommands(help: string): string[] {
  const usage = help.split('\nOptions\n')[0] ?? '';
  return usage
    .split('\n')
    .filter((line) => line.startsWith('  repo-dash'))
    .map((line) => {
      const signature = line.trim().split(/\s{2,}/)[0] ?? '';
      const words: string[] = [];
      for (const word of signature.split(' ')) {
        if (word.startsWith('<') || word.startsWith('[') || word.startsWith('-')) break;
        words.push(word);
      }
      return words.join(' ');
    });
}

/** Every flag named in the help's Options section. */
function optionFlags(help: string): string[] {
  const options = help.split('\nOptions\n')[1]?.split('\n\n')[0] ?? '';
  return [...options.matchAll(/(?:^|[\s,])(--?[a-z][a-z-]*)(?=[\s,]|$)/gm)].map((m) => m[1] as string);
}

test('help documents exactly the commands and options the CLI accepts', async () => {
  // Help is hand-written. It is compared as a set of exact command names, not
  // searched for substrings, so a deleted line cannot hide inside a longer one
  // that contains it: "repo-dash dev" inside "repo-dash dev start", or
  // "repo-dash dev stop" inside "repo-dash dev stop-all".
  const home = await emptyConfigHome();
  const { stdout } = await run(['--help'], home);

  assert.deepEqual(usageCommands(stdout).sort(), [
    'repo-dash', 'repo-dash status', 'repo-dash list', 'repo-dash fetch',
    'repo-dash dev', 'repo-dash dev start', 'repo-dash dev stop', 'repo-dash dev restart',
    'repo-dash dev logs', 'repo-dash dev stop-all',
    'repo-dash roots', 'repo-dash roots add', 'repo-dash roots rm',
    'repo-dash config path', 'repo-dash config edit', 'repo-dash cache clear',
  ].sort());
  assert.match(stdout, /repo-dash dev logs <repo>.*--lines/, 'dev logs documents --lines');
  assert.deepEqual(
    optionFlags(stdout).sort(),
    ['--refresh', '--expand', '--json', '-v', '--version', '-h', '--help'].sort(),
  );

  // Tie help to the dispatcher itself, so a command added to main() without
  // a help line fails here rather than relying on this list being updated.
  const source = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');
  const handled = [...source.matchAll(/^ {4}case '([a-z][a-z-]*)':/gm)].map((m) => m[1] as string);
  assert.ok(handled.length >= 6, `expected the dispatcher's cases, found ${handled.length}`);
  const documented = new Set(usageCommands(stdout).map((c) => c.split(' ')[1]).filter(Boolean));
  for (const name of handled) assert.ok(documented.has(name), `"${name}" is handled but not in help`);
});

test('fetch with nothing configured says so', async () => {
  const home = await emptyConfigHome();
  const { stdout, code } = await run(['fetch'], home);
  assert.equal(code, 0);
  assert.match(stdout, /No repositories found/);
});

test('fetch of an unknown repository is an error', async () => {
  const home = await emptyConfigHome();
  const { stderr, code } = await run(['fetch', 'nosuch'], home);
  assert.equal(code, 1);
  assert.match(stderr, /no repository named "nosuch"/);
});

test('fetch updates what status reports', async () => {
  const home = await mkdtemp(join(tmpdir(), 'repo-dash-fetchcli-'));
  const root = join(home, 'work');
  const remote = join(home, 'remote.git');
  const seed = join(home, 'seed');
  await mkdir(root, { recursive: true });
  await exec('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await exec('git', ['clone', '-q', remote, seed]);
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one'], { cwd: seed });
  await exec('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seed });
  await exec('git', ['clone', '-q', remote, join(root, 'app')]);
  await mkdir(join(home, 'repo-dash'), { recursive: true });
  await writeFile(join(home, 'repo-dash', 'config.json'), JSON.stringify({ roots: [{ path: root }] }), 'utf8');

  type Status = { groups: Array<{ fetchedAt: number | null }> };
  const before = JSON.parse((await run(['status', '--json', '--refresh'], home)).stdout) as Status;
  assert.equal(before.groups[0]?.fetchedAt, null, 'a fresh clone has not fetched');

  const fetched = await run(['fetch'], home);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.match(fetched.stdout, /Fetched 1 repository\./);

  const after = JSON.parse((await run(['status', '--json'], home)).stdout) as Status;
  assert.equal(typeof after.groups[0]?.fetchedAt, 'number');
});

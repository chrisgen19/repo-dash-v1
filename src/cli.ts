#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { addRoot, configPath, expandPath, loadConfig, removeRoot, saveConfig } from './config.js';
import type { Config } from './config.js';
import { discoverRepos } from './git/discover.js';
import type { DiscoveredRepo } from './git/discover.js';
import { clearCache, readCache, writeCache } from './cache.js';
import { buildGroups } from './git/snapshot.js';
import type { RepoGroup } from './git/snapshot.js';
import { renderTable } from './ui/table.js';
import { isTerminalEditor, parseRootsAdd, splitCommand } from './util/args.js';

// Piping into a pager or `head` closes stdout early. Without this, the
// resulting EPIPE surfaces as an unhandled error and a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const HELP = `repo-dash - multi-repo git dashboard

Usage
  repo-dash                      Launch the interactive dashboard
  repo-dash status [--expand]    Branch, ahead/behind and dirty counts per repo
  repo-dash list [--json]        List discovered repositories
  repo-dash roots                Show configured scan roots
  repo-dash roots add <path> [--depth N]
  repo-dash roots rm <path>
  repo-dash config path          Print the config file location
  repo-dash config edit          Open the config in $EDITOR
  repo-dash cache clear          Drop cached discovery results

Options
  --refresh     Bypass the cache and rescan
  --expand      Show linked worktrees under each repository
  --json        Machine-readable output
  -h, --help    Show this help
`;

/** Options accepted before a command; everything else belongs to the subcommand. */
const GLOBAL_FLAGS = new Set(['--refresh', '--json', '--expand', '-h', '--help']);

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  // Options may precede the command, so `repo-dash --refresh` still selects the
  // default dashboard. Only leading options are consumed here: everything from
  // the command onwards belongs to that subcommand, so `roots add <path>
  // --depth 2` keeps both halves of its own option.
  let cursor = 0;
  while (cursor < argv.length && (argv[cursor] as string).startsWith('-')) {
    const flag = (argv[cursor] as string).split('=')[0] as string;
    if (!GLOBAL_FLAGS.has(flag)) {
      process.stderr.write(`Unknown option: ${argv[cursor] as string}\n\n${HELP}`);
      return 1;
    }
    cursor++;
  }
  const leading = argv.slice(0, cursor);
  const [command, ...rest] = argv.slice(cursor);

  const hasFlag = (name: string): boolean => leading.includes(name) || rest.includes(name);
  const refresh = hasFlag('--refresh');

  switch (command) {
    case undefined:
      // A pipe or redirect gets the static table; only a terminal gets the TUI.
      return process.stdout.isTTY === true
        ? cmdDashboard(refresh)
        : cmdStatus(refresh, true, false);
    case 'list':
      return cmdList(rest, refresh, hasFlag('--json'));
    case 'status':
      return cmdStatus(refresh, hasFlag('--expand'), hasFlag('--json'));
    case 'roots':
      return cmdRoots(rest);
    case 'config':
      return cmdConfig(rest);
    case 'cache':
      return cmdCache(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

/**
 * Discovery inputs that should invalidate the cache when they change.
 * Roots are hashed after expansion so a changed `$VAR` is noticed, and the
 * per-repo overrides are included because discovery filters on `hidden`.
 */
function discoveryKey(cfg: Config): string {
  const roots = cfg.roots.map((r) => [
    expandPath(r.path), r.maxDepth ?? null, r.enabled !== false, r.label ?? null,
  ]);
  const material = JSON.stringify([
    roots, cfg.ignore, cfg.pruneDirs, cfg.maxDepth,
    cfg.includeHidden, cfg.scanInsideRepos, cfg.followSymlinks, cfg.repos,
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

async function getRepos(cfg: Config, refresh: boolean): Promise<{ repos: DiscoveredRepo[]; cached: boolean; elapsedMs: number; missingRoots: string[] }> {
  const key = discoveryKey(cfg);
  if (!refresh) {
    const hit = await readCache<{ repos: DiscoveredRepo[]; missingRoots: string[] }>('discovery', key, cfg.cacheTtlSeconds);
    if (hit) return { ...hit, cached: true, elapsedMs: 0 };
  }
  const result = await discoverRepos(cfg);

  // The scan already succeeded, so a cache that cannot be written is a
  // warning, not a reason to discard results and exit non-zero.
  try {
    await writeCache('discovery', key, { repos: result.repos, missingRoots: result.missingRoots });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: could not write cache: ${reason}\n`);
  }

  return { repos: result.repos, missingRoots: result.missingRoots, cached: false, elapsedMs: result.elapsedMs };
}

async function cmdList(_rest: string[], refresh: boolean, json: boolean): Promise<number> {
  const cfg = await loadConfig();
  const { repos, cached, elapsedMs, missingRoots } = await getRepos(cfg, refresh);

  if (json) {
    process.stdout.write(`${JSON.stringify({ repos, missingRoots, cached }, null, 2)}\n`);
    return 0;
  }

  for (const root of missingRoots) {
    process.stderr.write(`warning: root not found, skipped: ${root}\n`);
  }

  if (repos.length === 0) {
    process.stdout.write(`No repositories found.\nEdit ${configPath()} or run: repo-dash roots add <path>\n`);
    return 0;
  }

  const width = Math.max(...repos.map((r) => r.name.length));
  for (const repo of repos) {
    const marker = repo.kind === 'normal' ? '' : ` (${repo.kind})`;
    process.stdout.write(`${repo.name.padEnd(width)}  ${repo.path}${marker}\n`);
  }

  const timing = cached ? 'from cache' : `scanned in ${elapsedMs}ms`;
  process.stdout.write(`\n${repos.length} repositories, ${timing}\n`);
  return 0;
}

/** Launches the Ink dashboard. Ink is imported lazily so subcommands stay fast. */
async function cmdDashboard(refresh: boolean): Promise<number> {
  const cfg = await loadConfig();
  const [{ render }, { App }, { createElement }] = await Promise.all([
    import('ink'),
    import('./ui/app.js'),
    import('react'),
  ]);

  let first = refresh;
  const load = async (force: boolean): Promise<{ groups: RepoGroup[]; warnings: string[] }> => {
    const { repos, missingRoots } = await getRepos(cfg, force || first);
    first = false;
    const warnings = missingRoots.map((r) => `root not found, skipped: ${r}`);
    if (repos.length === 0) return { groups: [], warnings };
    return { groups: await buildGroups(repos, cfg), warnings };
  };

  let instance: { clear: () => void } | undefined;

  /**
   * Hands the terminal to a child and takes it back afterwards. A terminal
   * editor spawned detached with no stdio gets no terminal at all and simply
   * hangs in the background, so it has to run attached.
   */
  const runAttached = (exe: string, args: string[]): Promise<void> =>
    new Promise((resolveRun) => {
      instance?.clear();
      const stdin = process.stdin;
      const wasRaw = stdin.isTTY === true && stdin.isRaw === true;
      if (wasRaw) stdin.setRawMode(false);
      stdin.pause();

      const child = spawn(exe, args, { stdio: 'inherit' });
      const restore = (): void => {
        stdin.resume();
        if (wasRaw) stdin.setRawMode(true);
        instance?.clear();
        resolveRun();
      };
      child.on('error', restore);
      child.on('exit', restore);
    });

  const openInEditor = async (path: string): Promise<void> => {
    const [exe, ...args] = splitCommand(cfg.editor);
    if (exe === undefined) return;
    const full = [...args, path];

    if (isTerminalEditor(exe, args)) {
      await runAttached(exe, full);
      return;
    }
    // A windowed editor detaches, so closing the dashboard does not close it.
    // The launch is still awaited far enough to report a missing executable
    // rather than claiming success.
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const child = spawn(exe, full, { stdio: 'ignore', detached: true });
      child.once('error', rejectSpawn);
      child.once('spawn', () => {
        child.unref();
        resolveSpawn();
      });
    });
  };

  instance = render(createElement(App, { load, openInEditor }));
  await (instance as unknown as { waitUntilExit: () => Promise<void> }).waitUntilExit();
  return 0;
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

async function cmdStatus(refresh: boolean, expand: boolean, json: boolean): Promise<number> {
  const cfg = await loadConfig();
  const { repos, missingRoots } = await getRepos(cfg, refresh);

  for (const root of missingRoots) {
    process.stderr.write(`warning: root not found, skipped: ${root}\n`);
  }
  if (repos.length === 0) {
    // --json must stay machine-readable even with nothing to report.
    if (json) {
      process.stdout.write(`${JSON.stringify({ groups: [], missingRoots }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`No repositories found.\nEdit ${configPath()} or run: repo-dash roots add <path>\n`);
    return 0;
  }

  const started = Date.now();
  const groups = await buildGroups(repos, cfg);

  if (json) {
    process.stdout.write(`${JSON.stringify({ groups, missingRoots }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${renderTable(groups, { expand })}\n`);

  const worktrees = groups.reduce((n, g) => n + g.worktrees.length, 0);
  // Counts every working tree with changes, main and linked alike, so the
  // summary cannot contradict a dirty worktree shown under --expand.
  const dirty =
    groups.filter((g) => (g.status?.dirty ?? 0) > 0).length +
    groups.reduce((n, g) => n + g.worktrees.filter((w) => (w.status?.dirty ?? 0) > 0).length, 0);
  process.stdout.write(
    `\n${plural(groups.length, 'repository', 'repositories')}, ` +
      `${plural(worktrees, 'linked worktree')}, ` +
      `${plural(dirty, 'dirty working tree')}, read in ${Date.now() - started}ms\n`,
  );
  return 0;
}

async function cmdRoots(rest: string[]): Promise<number> {
  const cfg = await loadConfig();
  const [sub, ...args] = rest;

  if (sub === undefined) {
    if (cfg.roots.length === 0) {
      process.stdout.write('No roots configured. Add one with: repo-dash roots add <path>\n');
      return 0;
    }
    for (const root of cfg.roots) {
      const depth = root.maxDepth ?? cfg.maxDepth;
      const state = root.enabled === false ? ' [disabled]' : '';
      const label = root.label ? ` (${root.label})` : '';
      process.stdout.write(`${root.path}${label}  depth=${depth}${state}\n  -> ${expandPath(root.path)}\n`);
    }
    return 0;
  }

  if (sub === 'add') {
    const parsed = parseRootsAdd(args);
    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\nUsage: repo-dash roots add <path> [--depth N]\n`);
      return 1;
    }
    const { path, maxDepth: depth } = parsed.value;
    const added = await addRoot(cfg, path, depth);
    process.stdout.write(added ? `Added root: ${path}\n` : `Root already configured: ${path}\n`);
    if (added) await clearCache();
    return added ? 0 : 1;
  }

  if (sub === 'rm' || sub === 'remove') {
    const path = args[0];
    if (!path) {
      process.stderr.write('Usage: repo-dash roots rm <path>\n');
      return 1;
    }
    const removed = await removeRoot(cfg, path);
    process.stdout.write(removed ? `Removed root: ${path}\n` : `No such root: ${path}\n`);
    if (removed) await clearCache();
    return removed ? 0 : 1;
  }

  process.stderr.write(`Unknown roots subcommand: ${sub}\n`);
  return 1;
}

async function cmdConfig(rest: string[]): Promise<number> {
  const [sub] = rest;

  if (sub === 'path' || sub === undefined) {
    process.stdout.write(`${configPath()}\n`);
    return 0;
  }

  if (sub === 'edit') {
    const cfg = await loadConfig();
    await saveConfig(cfg); // ensure the file exists before opening it
    const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? cfg.editor;
    const [exe, ...editorArgs] = splitCommand(editor);
    if (exe === undefined) {
      process.stderr.write('No editor configured. Set $VISUAL, $EDITOR, or "editor" in the config.\n');
      return 1;
    }
    return new Promise<number>((resolvePromise) => {
      const child = spawn(exe, [...editorArgs, configPath()], { stdio: 'inherit' });
      child.on('error', (err) => {
        process.stderr.write(`Could not launch "${editor}": ${err.message}\n`);
        resolvePromise(1);
      });
      child.on('exit', (code) => resolvePromise(code ?? 0));
    });
  }

  process.stderr.write(`Unknown config subcommand: ${sub}\n`);
  return 1;
}

async function cmdCache(rest: string[]): Promise<number> {
  if (rest[0] === 'clear') {
    await clearCache();
    process.stdout.write('Cache cleared.\n');
    return 0;
  }
  process.stderr.write('Usage: repo-dash cache clear\n');
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });

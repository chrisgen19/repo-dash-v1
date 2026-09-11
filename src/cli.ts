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
import { basename } from 'node:path';
import { cellWidth, padCells } from './ui/format.js';
import { launchEditor } from './ui/editor.js';
import { attachDev, readDevStates, restartDev, startDev, stopAllDev, stopDev } from './proc/dev.js';
import { listSessions, tmuxAvailable } from './proc/tmux.js';
import { portsByPane } from './proc/ports.js';
import { canonicalPath } from './util/fs.js';
import type { LoadResult, DevAction } from './ui/app.js';
import type { Suspend } from './ui/editor.js';
import { parseRootsAdd, splitCommand } from './util/args.js';

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
  repo-dash dev                  List dev servers this tool is running
  repo-dash dev start <repo>     Start a dev server
  repo-dash dev stop <repo>      Stop one
  repo-dash dev stop-all         Stop every session this tool started
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
      // Both streams must be terminals: Ink cannot put a redirected stdin into
      // raw mode, so the dashboard would render without accepting any keys.
      return process.stdout.isTTY === true && process.stdin.isTTY === true
        ? cmdDashboard(refresh)
        : cmdStatus(refresh, true, false);
    case 'list':
      return cmdList(rest, refresh, hasFlag('--json'));
    case 'status':
      return cmdStatus(refresh, hasFlag('--expand'), hasFlag('--json'));
    case 'dev':
      return cmdDev(rest, refresh);
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

  // Cells, not code units, so a CJK or emoji name still lines up.
  const width = Math.max(...repos.map((r) => cellWidth(r.name)));
  for (const repo of repos) {
    const marker = repo.kind === 'normal' ? '' : ` (${repo.kind})`;
    process.stdout.write(`${padCells(repo.name, width)}  ${repo.path}${marker}\n`);
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
  const load = async (force: boolean): Promise<LoadResult> => {
    const { repos, missingRoots } = await getRepos(cfg, force || first);
    first = false;
    const warnings = missingRoots.map((r) => `root not found, skipped: ${r}`);
    if (repos.length === 0) return { groups: [], warnings, dev: new Map() };

    const groups = await buildGroups(repos, cfg);
    // Every working directory the dashboard can show, main checkouts included.
    const paths = groups.flatMap((g) => [g.path, ...g.worktrees.map((w) => w.path)]);
    const { tmux, states } = await readDevStates(paths, cfg);
    if (!tmux) warnings.push('tmux not found, dev servers unavailable');
    return { groups, warnings, dev: states };
  };

  const devAction = async (
    action: DevAction,
    path: string,
    suspend: Suspend,
  ): Promise<string | null> => {
    if (action === 'start') return startDev(path, cfg);
    if (action === 'stop') return stopDev(path);
    if (action === 'restart') return restartDev(path, cfg);
    // Attaching replaces the dashboard on screen until the user detaches.
    return attachDev(path, suspend);
  };

  const openInEditor = (path: string, suspend: Suspend): Promise<void> =>
    launchEditor(cfg.editor, path, suspend);

  const instance = render(createElement(App, { load, openInEditor, devAction }));
  await instance.waitUntilExit();
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
  const paths = groups.flatMap((g) => [g.path, ...g.worktrees.map((w) => w.path)]);
  const { states } = await readDevStates(paths, cfg);

  if (json) {
    const dev = Object.fromEntries(states);
    process.stdout.write(`${JSON.stringify({ groups, dev, missingRoots }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${renderTable(groups, { expand, dev: (p) => states.get(p) })}\n`);

  const worktrees = groups.reduce((n, g) => n + g.worktrees.length, 0);
  // Counts every working tree with changes, main and linked alike, so the
  // summary cannot contradict a dirty worktree shown under --expand.
  const dirty =
    groups.filter((g) => (g.status?.dirty ?? 0) > 0).length +
    groups.reduce((n, g) => n + g.worktrees.filter((w) => (w.status?.dirty ?? 0) > 0).length, 0);
  const running = [...states.values()].filter((s) => s.running).length;
  process.stdout.write(
    `\n${plural(groups.length, 'repository', 'repositories')}, ` +
      `${plural(worktrees, 'linked worktree')}, ` +
      `${plural(dirty, 'dirty working tree')}, ${plural(running, 'dev server')} running, ` +
      `read in ${Date.now() - started}ms\n`,
  );
  return 0;
}

/**
 * Every working directory the dashboard can act on: each repository's main
 * checkout plus its linked worktrees. Discovery alone is not enough, because a
 * main checkout outside the roots is still shown, and acted on, via a worktree
 * that is inside them.
 */
async function dashboardPaths(cfg: Config, refresh: boolean): Promise<string[]> {
  const { repos } = await getRepos(cfg, refresh);
  if (repos.length === 0) return [];
  const groups = await buildGroups(repos, cfg);
  return groups.flatMap((g) => [g.path, ...g.worktrees.map((w) => w.path)]);
}

/**
 * Resolves a repository argument to a path: an exact path in either form, or a
 * unique basename. Running sessions are candidates too, so a server can be
 * stopped even after its repository leaves the configured roots.
 */
async function findRepoPath(
  cfg: Config,
  needle: string,
  refresh: boolean,
): Promise<string | { error: string }> {
  const candidates = new Set(await dashboardPaths(cfg, refresh));
  for (const session of (await listSessions()).values()) {
    if (session.path !== null) candidates.add(session.path);
  }

  const absolute = expandPath(needle);
  const real = await canonicalPath(absolute);
  for (const path of candidates) {
    if (path === absolute || path === needle) return path;
    if ((await canonicalPath(path)) === real) return path;
  }

  const matches = [...candidates].filter((path) => basename(path) === needle);
  if (matches.length === 1) return matches[0] as string;
  if (matches.length === 0) return { error: `no repository named "${needle}"` };
  return { error: `"${needle}" matches ${matches.length} repositories; use a full path` };
}

async function cmdDev(rest: string[], refresh: boolean): Promise<number> {
  const cfg = await loadConfig();
  const [sub, target] = rest;

  if (sub === undefined || sub === 'list') {
    if (!(await tmuxAvailable())) {
      process.stderr.write('tmux is not installed, so no dev servers can run\n');
      return 1;
    }
    // Sessions record their own directory, so this lists everything running
    // regardless of whether the repository is still inside a scan root.
    const sessions = [...(await listSessions()).values()];
    if (sessions.length === 0) {
      process.stdout.write('No dev servers running.\n');
      return 0;
    }

    const ports = await portsByPane(sessions.map((s) => s.panePid));
    const label = (s: (typeof sessions)[number]): string => (s.path === null ? s.name : basename(s.path));
    const width = Math.max(...sessions.map((s) => cellWidth(label(s))));
    for (const session of sessions) {
      const found = ports.get(session.panePid) ?? [];
      const shown = found.length > 0 ? `:${found.join(',')}` : '(no port yet)';
      process.stdout.write(`${padCells(label(session), width)}  ${shown}  ${session.path ?? session.name}\n`);
    }
    process.stdout.write(`\n${plural(sessions.length, 'dev server')} running\n`);
    return 0;
  }

  if (sub === 'stop-all') {
    const stopped = await stopAllDev();
    process.stdout.write(`Stopped ${plural(stopped, 'dev server')}.\n`);
    return 0;
  }

  if (sub !== 'start' && sub !== 'stop' && sub !== 'restart') {
    process.stderr.write(`Unknown dev subcommand: ${sub}\n`);
    return 1;
  }
  if (target === undefined) {
    process.stderr.write(`Usage: repo-dash dev ${sub} <repo>\n`);
    return 1;
  }

  const found = await findRepoPath(cfg, target, refresh);
  if (typeof found !== 'string') {
    process.stderr.write(`${found.error}\n`);
    return 1;
  }

  const error =
    sub === 'start' ? await startDev(found, cfg)
      : sub === 'stop' ? await stopDev(found)
        : await restartDev(found, cfg);
  if (error !== null) {
    process.stderr.write(`${error}\n`);
    return 1;
  }
  process.stdout.write(`${sub === 'stop' ? 'Stopped' : 'Started'} ${basename(found)}\n`);
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

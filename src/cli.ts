#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { addRoot, configPath, expandPath, loadConfig, removeRoot, saveConfig } from './config.js';
import type { Config } from './config.js';
import { discoverRepos } from './git/discover.js';
import type { DiscoveredRepo } from './git/discover.js';
import { clearCache, readCache, writeCache } from './cache.js';
import { buildGroups } from './git/snapshot.js';
import { renderTable } from './ui/table.js';
import { parseRootsAdd, splitCommand } from './util/args.js';

// Piping into a pager or `head` closes stdout early. Without this, the
// resulting EPIPE surfaces as an unhandled error and a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const HELP = `repo-dash - multi-repo git dashboard

Usage
  repo-dash                      Launch the dashboard (available from phase 3)
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

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case 'list':
      return cmdList(rest, argv.includes('--refresh'), argv.includes('--json'));
    case 'status':
      return cmdStatus(argv.includes('--refresh'), argv.includes('--expand'), argv.includes('--json'));
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

async function cmdStatus(refresh: boolean, expand: boolean, json: boolean): Promise<number> {
  const cfg = await loadConfig();
  const { repos, missingRoots } = await getRepos(cfg, refresh);

  for (const root of missingRoots) {
    process.stderr.write(`warning: root not found, skipped: ${root}\n`);
  }
  if (repos.length === 0) {
    process.stdout.write(`No repositories found.\nEdit ${configPath()} or run: repo-dash roots add <path>\n`);
    return 0;
  }

  const started = Date.now();
  const groups = await buildGroups(repos, cfg);

  if (json) {
    process.stdout.write(`${JSON.stringify({ groups }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${renderTable(groups, { expand })}\n`);

  const worktrees = groups.reduce((n, g) => n + g.worktrees.length, 0);
  const dirty = groups.filter((g) => (g.status?.dirty ?? 0) > 0).length;
  process.stdout.write(
    `\n${groups.length} repositories, ${worktrees} linked worktrees, ${dirty} dirty, read in ${Date.now() - started}ms\n`,
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

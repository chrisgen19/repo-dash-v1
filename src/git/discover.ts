import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Config, RootConfig } from '../config.js';
import { expandPath } from '../config.js';
import { matchesAny } from '../util/glob.js';
import { pool } from '../util/pool.js';

export interface DiscoveredRepo {
  /** Absolute path to the working directory containing `.git`. */
  path: string;
  name: string;
  /** Expanded path of the configured root this repo was found under. */
  root: string;
  rootLabel: string | undefined;
  /** True when `.git` is a file rather than a directory, which means a linked worktree. */
  isLinkedWorktree: boolean;
  depth: number;
}

export interface DiscoverResult {
  repos: DiscoveredRepo[];
  /** Roots that are configured but missing or unreadable on disk. */
  missingRoots: string[];
  scannedDirs: number;
  elapsedMs: number;
}

/** Walks every enabled root and returns repositories sorted by path. */
export async function discoverRepos(cfg: Config): Promise<DiscoverResult> {
  const started = Date.now();
  const active = cfg.roots.filter((r) => r.enabled !== false);
  const repos: DiscoveredRepo[] = [];
  const missingRoots: string[] = [];
  let scannedDirs = 0;

  for (const root of active) {
    const abs = expandPath(root.path);
    if (!(await isReadableDir(abs))) {
      missingRoots.push(root.path);
      continue;
    }
    const found = await scanRoot(abs, root, cfg);
    scannedDirs += found.scannedDirs;
    repos.push(...found.repos);
  }

  const deduped = dedupe(repos).filter((r) => cfg.repos[r.path]?.hidden !== true);
  deduped.sort((a, b) => a.path.localeCompare(b.path));

  return { repos: deduped, missingRoots, scannedDirs, elapsedMs: Date.now() - started };
}

async function scanRoot(
  abs: string,
  root: RootConfig,
  cfg: Config,
): Promise<{ repos: DiscoveredRepo[]; scannedDirs: number }> {
  const maxDepth = root.maxDepth ?? cfg.maxDepth;
  const repos: DiscoveredRepo[] = [];
  let scannedDirs = 0;

  // Breadth-first, one level at a time, so `concurrency` applies across siblings.
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: abs, depth: 0 }];

  while (frontier.length > 0) {
    const results = await pool(frontier, cfg.concurrency, async ({ dir, depth }) => {
      scannedDirs++;
      return visit(dir, depth, maxDepth, abs, root, cfg);
    });

    const nextFrontier: Array<{ dir: string; depth: number }> = [];
    for (const r of results) {
      if (r.repo) repos.push(r.repo);
      nextFrontier.push(...r.children);
    }
    frontier = nextFrontier;
  }

  return { repos, scannedDirs };
}

interface VisitResult {
  repo: DiscoveredRepo | undefined;
  children: Array<{ dir: string; depth: number }>;
}

async function visit(
  dir: string,
  depth: number,
  maxDepth: number,
  rootAbs: string,
  root: RootConfig,
  cfg: Config,
): Promise<VisitResult> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Unreadable directory (permissions, broken mount). Skip it rather than fail the scan.
    return { repo: undefined, children: [] };
  }

  const gitEntry = entries.find((e) => e.name === '.git');
  let repo: DiscoveredRepo | undefined;

  if (gitEntry) {
    repo = {
      path: dir,
      name: basename(dir),
      root: rootAbs,
      rootLabel: root.label,
      isLinkedWorktree: gitEntry.isFile(),
      depth,
    };
  }

  // A repo was found and the user does not want nested scanning: stop here.
  if (repo && !cfg.scanInsideRepos) return { repo, children: [] };
  if (depth >= maxDepth) return { repo, children: [] };

  const children: Array<{ dir: string; depth: number }> = [];
  for (const entry of entries) {
    if (!(await isDirLike(dir, entry, cfg))) continue;
    if (cfg.pruneDirs.includes(entry.name)) continue;
    if (!cfg.includeHidden && entry.name.startsWith('.')) continue;

    const child = join(dir, entry.name);
    if (matchesAny(child, cfg.ignore)) continue;
    children.push({ dir: child, depth: depth + 1 });
  }

  return { repo, children };
}

async function isDirLike(
  parent: string,
  entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean },
  cfg: Config,
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink() || !cfg.followSymlinks) return false;
  try {
    return (await stat(join(parent, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

/** Overlapping roots can surface the same repo twice; first occurrence wins. */
function dedupe(repos: readonly DiscoveredRepo[]): DiscoveredRepo[] {
  const seen = new Set<string>();
  const out: DiscoveredRepo[] = [];
  for (const r of repos) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(r);
  }
  return out;
}

async function isReadableDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

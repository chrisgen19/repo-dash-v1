import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Config, RootConfig } from '../config.js';
import { expandPath } from '../config.js';
import { matchesAny } from '../util/glob.js';
import { pool } from '../util/pool.js';

/**
 * `normal`    - `.git` is a directory
 * `worktree`  - `.git` file pointing into `.../worktrees/<name>`
 * `submodule` - `.git` file pointing into `.../modules/<name>`
 * `linked`    - `.git` file whose target is unrecognized or unreadable
 * `bare`      - a bare repository, reported by git rather than discovered
 */
export type RepoKind = 'normal' | 'worktree' | 'submodule' | 'linked' | 'bare';

export interface DiscoveredRepo {
  /** Absolute path to the working directory containing `.git`. */
  path: string;
  name: string;
  /** Expanded path of the configured root this repo was found under. */
  root: string;
  rootLabel: string | undefined;
  /** How this working directory relates to its git metadata. */
  kind: RepoKind;
  depth: number;
}

/**
 * A `.git` file alone cannot tell a linked worktree from a submodule: both are
 * pointer files. The gitdir target distinguishes them, but the two markers
 * nest in either order, so the innermost structural marker wins:
 *
 *   .git/worktrees/wt                  -> worktree
 *   .git/worktrees/wt/modules/sub      -> submodule inside a worktree
 *   .git/modules/sub                   -> submodule
 *   .git/modules/sub/worktrees/wt      -> worktree of a submodule
 *   .git/modules/worktrees             -> submodule that is named "worktrees"
 */
export async function classifyGitEntry(dir: string, gitIsFile: boolean): Promise<RepoKind> {
  if (!gitIsFile) return 'normal';
  try {
    const text = await readFile(join(dir, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match) return 'linked';

    const segments = (match[1] ?? '').trim().replace(/\\/g, '/').split('/');

    // A marker is structural only when a name follows it, as in
    // ".git/modules/<name>". The final segment is that name, so a submodule
    // called "worktrees" must not be read as a worktree marker.
    let kind: RepoKind = 'linked';
    let found = -1;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (segment !== 'worktrees' && segment !== 'modules') continue;
      if (i <= found) continue;
      found = i;
      kind = segment === 'worktrees' ? 'worktree' : 'submodule';
    }
    return found === -1 ? 'linked' : kind;
  } catch {
    return 'linked';
  }
}

/** Classifies a working directory that was not part of a discovery scan. */
export async function classifyRepoPath(dir: string): Promise<RepoKind> {
  try {
    return await classifyGitEntry(dir, (await stat(join(dir, '.git'))).isFile());
  } catch {
    return 'normal';
  }
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

  // Only tracked when following symlinks, where a link such as `loop -> .`
  // would otherwise be traversed once per level. Lexical dedupe cannot catch
  // those, since each pass yields a distinct path.
  const visited = new Set<string>();
  if (cfg.followSymlinks) visited.add(await canonical(abs));

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
      for (const child of r.children) {
        if (cfg.followSymlinks) {
          const real = await canonical(child.dir);
          if (visited.has(real)) continue;
          visited.add(real);
        }
        nextFrontier.push(child);
      }
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
      kind: await classifyGitEntry(dir, gitEntry.isFile()),
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

/** Resolves symlinks so the same physical directory is only queued once. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function isReadableDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

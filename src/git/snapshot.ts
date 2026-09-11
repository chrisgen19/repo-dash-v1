import { basename } from 'node:path';
import type { Config } from '../config.js';
import { pool } from '../util/pool.js';
import { canonicalPath } from '../util/fs.js';
import { classifyRepoPath } from './discover.js';
import type { DiscoveredRepo, RepoKind } from './discover.js';
import { runGit, setGitConcurrency } from './exec.js';
import { readLastCommit } from './log.js';
import type { LastCommit } from './log.js';
import { readStatus } from './status.js';
import type { GitStatus } from './status.js';
import { readWorktrees } from './worktree.js';
import type { Worktree } from './worktree.js';

export interface WorktreeView {
  path: string;
  name: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  /** Null when the worktree could not be read. */
  status: GitStatus | null;
  lastCommit: LastCommit | null;
}

/**
 * One repository and its linked worktrees. A linked worktree never appears as
 * a group of its own, so it is listed once rather than twice.
 */
export interface RepoGroup {
  name: string;
  /** Path of the main worktree. */
  path: string;
  /** Shared git directory; the identity of the group. */
  commonDir: string;
  kind: RepoKind;
  rootLabel: string | undefined;
  /** False when the main worktree sits outside every configured root. */
  discovered: boolean;
  status: GitStatus | null;
  lastCommit: LastCommit | null;
  /** Linked worktrees only; the main worktree is this group. */
  worktrees: WorktreeView[];
}

interface Probe {
  repo: DiscoveredRepo;
  commonDir: string;
  status: GitStatus | null;
  lastCommit: LastCommit | null;
}

/** Reads status, last commit and shared git dir for one working directory. */
async function probe(repo: DiscoveredRepo, timeoutMs: number): Promise<Probe> {
  const [common, status, lastCommit] = await Promise.all([
    runGit(repo.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], timeoutMs),
    readStatus(repo.path, timeoutMs),
    readLastCommit(repo.path, timeoutMs),
  ]);
  // Fall back to the repo path so an unreadable repo still forms its own group.
  const commonDir = common.code === 0 ? common.stdout.trim() : repo.path;
  return { repo, commonDir, status, lastCommit };
}

export interface SnapshotOptions {
  timeoutMs?: number;
}

/** Builds one group per repository, folding linked worktrees into their parent. */
export async function buildGroups(
  repos: readonly DiscoveredRepo[],
  cfg: Config,
  options: SnapshotOptions = {},
): Promise<RepoGroup[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Every git call shares this ceiling, including the three each probe issues.
  setGitConcurrency(cfg.concurrency);
  const probes = await pool(repos, cfg.concurrency, (repo) => probe(repo, timeoutMs));

  const byCommonDir = new Map<string, Probe[]>();
  for (const p of probes) {
    const bucket = byCommonDir.get(p.commonDir);
    if (bucket) bucket.push(p);
    else byCommonDir.set(p.commonDir, [p]);
  }

  // Discovery drops hidden repos, but git reports every worktree, so the
  // override has to be applied again to what git returns.
  const hidden = await hiddenPaths(cfg);

  const built = await pool(
    [...byCommonDir.entries()],
    cfg.concurrency,
    ([commonDir, members]) => buildGroup(commonDir, members, cfg.concurrency, timeoutMs, hidden),
  );

  const groups = built.filter((g): g is RepoGroup => g !== null);
  groups.sort((a, b) => a.path.localeCompare(b.path));
  return groups;
}

/** Absolute paths marked hidden, indexed by both configured and canonical form. */
async function hiddenPaths(cfg: Config): Promise<Set<string>> {
  const hidden = new Set<string>();
  for (const [path, override] of Object.entries(cfg.repos)) {
    if (override?.hidden !== true) continue;
    hidden.add(path);
    hidden.add(await canonicalPath(path));
  }
  return hidden;
}

async function isHidden(path: string, hidden: Set<string>): Promise<boolean> {
  if (hidden.size === 0) return false;
  if (hidden.has(path)) return true;
  return hidden.has(await canonicalPath(path));
}

async function buildGroup(
  commonDir: string,
  members: Probe[],
  concurrency: number,
  timeoutMs: number,
  hidden: Set<string>,
): Promise<RepoGroup | null> {
  // git reports canonical paths, while a discovered path may run through a
  // symlinked root. Index both so the two can be matched.
  const byPath = new Map<string, Probe>();
  for (const member of members) {
    byPath.set(member.repo.path, member);
    const real = await canonicalPath(member.repo.path);
    if (!byPath.has(real)) byPath.set(real, member);
  }
  const find = async (path: string): Promise<Probe | undefined> =>
    byPath.get(path) ?? byPath.get(await canonicalPath(path));

  const anchor = members[0] as Probe;
  const worktrees = await readWorktrees(anchor.repo.path, timeoutMs);

  // git lists the main worktree first. Without it, treat the anchor as main.
  const main = worktrees[0];
  const listed = main?.path ?? anchor.repo.path;
  // Inside a submodule, and for a bare repository, git reports the git
  // directory rather than a checkout. That path is not a working tree, so the
  // anchor is the real main here.
  const reportedMain = listed === commonDir ? anchor.repo.path : listed;
  const mainProbe = await find(reportedMain);
  const source = mainProbe ?? anchor;
  // Prefer the path the user configured, so a symlinked root stays recognizable.
  const mainPath = mainProbe?.repo.path ?? reportedMain;

  // Hiding a repository hides it whole, worktrees included. Without this the
  // main checkout returns through git's own listing, mislabelled, because the
  // probe that described it was filtered out during discovery.
  if (await isHidden(mainPath, hidden)) return null;
  if (mainPath !== reportedMain && (await isHidden(reportedMain, hidden))) return null;

  const linked: Worktree[] = [];
  for (const wt of worktrees.slice(1)) {
    const known = await find(wt.path);
    const path = known?.repo.path ?? wt.path;
    if (await isHidden(path, hidden)) continue;
    if (path !== wt.path && (await isHidden(wt.path, hidden))) continue;
    linked.push(wt);
  }

  const views = await pool(linked, concurrency, async (wt) =>
    toView(wt, await find(wt.path), timeoutMs),
  );

  return {
    name: basename(mainPath),
    path: mainPath,
    commonDir,
    // The anchor may be a linked worktree, so its kind must not stand in for
    // the main checkout's. Read the reported main path instead.
    kind: mainProbe?.repo.kind ?? (await classifyRepoPath(reportedMain)),
    rootLabel: source.repo.rootLabel,
    discovered: mainProbe !== undefined,
    status: mainProbe ? mainProbe.status : main ? await readStatus(mainPath, timeoutMs) : source.status,
    lastCommit: mainProbe ? mainProbe.lastCommit : main ? await readLastCommit(mainPath, timeoutMs) : source.lastCommit,
    worktrees: views,
  };
}

/** Reuses a discovered probe, or reads the worktree directly when it is outside every root. */
async function toView(wt: Worktree, known: Probe | undefined, timeoutMs: number): Promise<WorktreeView> {
  const status = known ? known.status : await readStatus(wt.path, timeoutMs);
  const lastCommit = known ? known.lastCommit : await readLastCommit(wt.path, timeoutMs);
  const path = known?.repo.path ?? wt.path;
  return {
    path,
    name: basename(path),
    branch: wt.branch,
    detached: wt.detached,
    locked: wt.locked,
    prunable: wt.prunable,
    status,
    lastCommit,
  };
}

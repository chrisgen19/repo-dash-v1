import { basename } from 'node:path';
import type { Config } from '../config.js';
import { pool } from '../util/pool.js';
import type { DiscoveredRepo, RepoKind } from './discover.js';
import { runGit } from './exec.js';
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
  const probes = await pool(repos, cfg.concurrency, (repo) => probe(repo, timeoutMs));

  const byCommonDir = new Map<string, Probe[]>();
  for (const p of probes) {
    const bucket = byCommonDir.get(p.commonDir);
    if (bucket) bucket.push(p);
    else byCommonDir.set(p.commonDir, [p]);
  }

  const groups = await pool(
    [...byCommonDir.entries()],
    cfg.concurrency,
    ([commonDir, members]) => buildGroup(commonDir, members, timeoutMs),
  );

  groups.sort((a, b) => a.path.localeCompare(b.path));
  return groups;
}

async function buildGroup(commonDir: string, members: Probe[], timeoutMs: number): Promise<RepoGroup> {
  const byPath = new Map(members.map((m) => [m.repo.path, m]));
  const anchor = members[0] as Probe;
  const worktrees = await readWorktrees(anchor.repo.path, timeoutMs);

  // git lists the main worktree first. Without it, treat the anchor as main.
  const main = worktrees[0];
  const mainPath = main?.path ?? anchor.repo.path;
  const mainProbe = byPath.get(mainPath);
  const source = mainProbe ?? anchor;

  const linked = worktrees.slice(1);
  const views = await pool(linked, Math.max(1, Math.min(4, linked.length)), (wt) =>
    toView(wt, byPath.get(wt.path), timeoutMs),
  );

  return {
    name: basename(mainPath),
    path: mainPath,
    commonDir,
    kind: mainProbe?.repo.kind ?? source.repo.kind,
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
  return {
    path: wt.path,
    name: basename(wt.path),
    branch: wt.branch,
    detached: wt.detached,
    locked: wt.locked,
    prunable: wt.prunable,
    status,
    lastCommit,
  };
}

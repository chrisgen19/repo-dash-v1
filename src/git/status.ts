import { runGit } from './exec.js';

export interface GitStatus {
  /** Null in a repository with no commits yet. */
  oid: string | null;
  /** Null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** Null when the branch has no upstream configured. */
  upstream: string | null;
  /** Commits ahead of upstream, as of the last fetch. Zero without an upstream. */
  ahead: number;
  /** Commits behind upstream, as of the last fetch. */
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Total entries with any change, untracked included. */
  dirty: number;
}

export const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z'] as const;

function empty(): GitStatus {
  return {
    oid: null, branch: null, detached: false, upstream: null,
    ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: 0,
  };
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * NUL separation is used rather than newlines because a tracked path may
 * legitimately contain a newline, which would otherwise inflate the counts.
 * A rename record (`2`) is followed by a second record holding the original
 * path, which must be consumed rather than counted.
 */
export function parseStatusV2(output: string): GitStatus {
  const status = empty();
  const records = output.split('\0');

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record === '') continue;

    if (record.startsWith('# ')) {
      applyHeader(status, record.slice(2));
      continue;
    }

    const kind = record[0];
    if (kind === '1' || kind === '2') {
      // "<kind> <XY> ..." where X is the staged state and Y the unstaged one.
      const xy = record.slice(2, 4);
      if (xy[0] !== undefined && xy[0] !== '.') status.staged++;
      if (xy[1] !== undefined && xy[1] !== '.') status.unstaged++;
      status.dirty++;
      if (kind === '2') i++; // skip the original path of a rename
    } else if (kind === 'u') {
      status.conflicted++;
      status.dirty++;
    } else if (kind === '?') {
      status.untracked++;
      status.dirty++;
    }
  }

  return status;
}

function applyHeader(status: GitStatus, header: string): void {
  const space = header.indexOf(' ');
  if (space === -1) return;
  const key = header.slice(0, space);
  const value = header.slice(space + 1);

  switch (key) {
    case 'branch.oid':
      status.oid = value === '(initial)' ? null : value;
      break;
    case 'branch.head':
      if (value === '(detached)') {
        status.detached = true;
        status.branch = null;
      } else {
        status.branch = value;
      }
      break;
    case 'branch.upstream':
      status.upstream = value;
      break;
    case 'branch.ab': {
      // "+<ahead> -<behind>"
      const match = /^\+(\d+)\s+-(\d+)$/.exec(value.trim());
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      break;
    }
    default:
      break;
  }
}

export async function readStatus(repoPath: string, timeoutMs?: number): Promise<GitStatus | null> {
  const result = await runGit(repoPath, STATUS_ARGS, timeoutMs);
  if (result.code !== 0) return null;
  return parseStatusV2(result.stdout);
}

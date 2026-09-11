import { runGit } from './exec.js';

export interface Worktree {
  path: string;
  /** Null in a worktree with no commits yet. */
  head: string | null;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

export const WORKTREE_ARGS = ['worktree', 'list', '--porcelain', '-z'] as const;

/**
 * Parses `git worktree list --porcelain -z`.
 *
 * Records are NUL-terminated attribute lines; an empty record ends one
 * worktree. The first worktree listed is the main one. Boolean attributes
 * appear as a bare label, valued ones as "label value".
 */
export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;

  const flush = (): void => {
    if (current !== null) worktrees.push(current);
    current = null;
  };

  for (const record of output.split('\0')) {
    if (record === '') {
      flush();
      continue;
    }

    const space = record.indexOf(' ');
    const key = space === -1 ? record : record.slice(0, space);
    const value = space === -1 ? '' : record.slice(space + 1);

    if (key === 'worktree') {
      flush();
      current = {
        path: value, head: null, branch: null, detached: false, bare: false,
        locked: false, lockedReason: null, prunable: false, prunableReason: null,
      };
      continue;
    }
    if (current === null) continue;

    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.locked = true;
        current.lockedReason = value === '' ? null : value;
        break;
      case 'prunable':
        current.prunable = true;
        current.prunableReason = value === '' ? null : value;
        break;
      default:
        break;
    }
  }

  flush();
  return worktrees;
}

export async function readWorktrees(repoPath: string, timeoutMs?: number): Promise<Worktree[]> {
  const result = await runGit(repoPath, WORKTREE_ARGS, timeoutMs);
  if (result.code !== 0) return [];
  return parseWorktreeList(result.stdout);
}

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from '../util/pool.js';
import { runGitRemote } from './exec.js';

export interface FetchResult {
  path: string;
  /** Null on success, otherwise why it failed. */
  error: string | null;
}

/** A fetch talks to the network, so it gets far longer than a local read. */
export const FETCH_TIMEOUT_MS = 60_000;

/** The first useful line of git's error output. */
function reason(stderr: string, code: number, timedOut: boolean): string {
  if (timedOut) return 'timed out';
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l !== '');
  return line === undefined ? `git exited with ${code}` : line.replace(/^fatal:\s*/, '');
}

/** Fetches every remote of one repository, pruning branches deleted upstream. */
export async function fetchRepo(path: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchResult> {
  const result = await runGitRemote(path, ['fetch', '--all', '--prune', '--quiet'], timeoutMs);
  return { path, error: result.code === 0 ? null : reason(result.stderr, result.code, result.timedOut) };
}

/**
 * Fetches several repositories. The shared git limit bounds how many run at
 * once, and `onProgress` reports each completion so a caller can show a count.
 */
export async function fetchRepos(
  paths: readonly string[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<FetchResult[]> {
  let done = 0;
  return pool(paths, concurrency, async (path) => {
    const result = await fetchRepo(path);
    done++;
    onProgress?.(done, paths.length);
    return result;
  });
}

/**
 * When a repository last fetched, as Unix seconds, or null if it never has.
 *
 * Every fetch, including the one inside `git pull`, rewrites FETCH_HEAD. A
 * fetch run from a linked worktree writes it under `worktrees/<name>/` and
 * leaves the main one alone, so the newest of them counts. A fresh clone
 * writes none, which is why a just-cloned repository reads as never fetched.
 */
export async function readFetchedAt(commonDir: string): Promise<number | null> {
  const candidates = [join(commonDir, 'FETCH_HEAD')];
  try {
    for (const name of await readdir(join(commonDir, 'worktrees'))) {
      candidates.push(join(commonDir, 'worktrees', name, 'FETCH_HEAD'));
    }
  } catch {
    // No linked worktrees.
  }

  let newest: number | null = null;
  for (const file of candidates) {
    try {
      const seconds = Math.floor((await stat(file)).mtimeMs / 1000);
      if (newest === null || seconds > newest) newest = seconds;
    } catch {
      // Never fetched from there.
    }
  }
  return newest;
}

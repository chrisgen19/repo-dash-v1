import { readFile, readdir, stat } from 'node:fs/promises';
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
export async function fetchRepo(
  path: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const args = ['fetch', '--all', '--prune', '--quiet'];
  const result = await runGitRemote(path, args, timeoutMs, signal);
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
  signal?: AbortSignal,
): Promise<FetchResult[]> {
  let done = 0;
  return pool(paths, concurrency, async (path) => {
    const result = await fetchRepo(path, FETCH_TIMEOUT_MS, signal);
    done++;
    onProgress?.(done, paths.length);
    return result;
  });
}

/** The remote a tracking ref belongs to: "origin/main" gives "origin". */
function remoteOf(upstream: string | null | undefined): string | null {
  if (upstream === null || upstream === undefined) return null;
  const slash = upstream.indexOf('/');
  return slash <= 0 ? null : upstream.slice(0, slash);
}

/**
 * Git drops a trailing slash and a trailing ".git" when it records a URL in
 * FETCH_HEAD, so `.../repo.git` is written as `.../repo`.
 */
function normalizeUrl(url: string): string {
  let out = url.trim();
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out.endsWith('.git') ? out.slice(0, -4) : out;
}

/**
 * Every remote's URL, in the shape FETCH_HEAD records. Empty when the file
 * cannot be read with confidence: an include directive can hold the real
 * values and an insteadOf rule can rewrite them, and a wrong answer here is
 * worse than none, so those give up and leave the weaker check in charge.
 */
async function readRemoteUrls(commonDir: string): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(join(commonDir, 'config'), 'utf8');
  } catch {
    return urls;
  }
  if (/^\s*\[\s*include/im.test(text) || /insteadof/i.test(text)) return urls;

  let current: string | null = null;
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section !== null) {
      const remote = /^remote\s+"(.*)"$/.exec((section[1] ?? '').trim());
      current = remote === null ? null : remote[1] ?? null;
      continue;
    }
    if (current === null) continue;
    const url = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line);
    if (url !== null && url[1] !== undefined && url[1] !== '') urls.set(current, normalizeUrl(url[1]));
  }
  return urls;
}

/**
 * When a repository last fetched the remote behind `upstream`, as Unix
 * seconds, or null if it never has.
 *
 * Every fetch, including the one inside `git pull`, rewrites FETCH_HEAD. A
 * fetch run from a linked worktree writes it under `worktrees/<name>/` and
 * leaves the main one alone, so the newest of them counts. A fresh clone
 * writes none, which is why a just-cloned repository reads as never fetched.
 *
 * A fetch that fails rewrites it too, truncating it to nothing before git
 * exits, so an empty file is skipped. That is not enough on its own: with
 * several remotes, `fetch --all` can fail for the tracked one and still leave
 * entries from another, which would report a stale upstream as just fetched.
 * Such a file is rejected only when another remote's URL is in it and the
 * tracked one's is not, so a URL shape we fail to recognise falls back to the
 * emptiness check rather than reading as never fetched.
 */
export async function readFetchedAt(commonDir: string, upstream?: string | null): Promise<number | null> {
  const candidates = [join(commonDir, 'FETCH_HEAD')];
  try {
    for (const name of await readdir(join(commonDir, 'worktrees'))) {
      candidates.push(join(commonDir, 'worktrees', name, 'FETCH_HEAD'));
    }
  } catch {
    // No linked worktrees.
  }

  const remote = remoteOf(upstream);
  const urls = remote === null ? new Map<string, string>() : await readRemoteUrls(commonDir);
  const tracked = remote === null ? undefined : urls.get(remote);
  const others = [...urls].filter(([name]) => name !== remote).map(([, url]) => url);

  let newest: number | null = null;
  for (const file of candidates) {
    try {
      const info = await stat(file);
      // Empty means a failed attempt, not a fetch. Git truncates the file
      // before it contacts the remote and only then writes the refs it got.
      if (info.size === 0) continue;
      if (tracked !== undefined && others.length > 0) {
        const text = await readFile(file, 'utf8');
        if (!text.includes(tracked) && others.some((url) => text.includes(url))) continue;
      }
      const seconds = Math.floor(info.mtimeMs / 1000);
      if (newest === null || seconds > newest) newest = seconds;
    } catch {
      // Never fetched from there.
    }
  }
  return newest;
}

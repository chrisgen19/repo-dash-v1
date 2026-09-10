import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';

const CACHE_VERSION = 1;

interface Envelope<T> {
  version: number;
  savedAt: number;
  /** Invalidates the entry when the inputs that produced it change. */
  key: string;
  data: T;
}

export function cacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  return xdg && xdg.length > 0 ? join(xdg, 'repo-dash') : join(homedir(), '.cache', 'repo-dash');
}

function cacheFile(name: string): string {
  return join(cacheDir(), `${name}.json`);
}

/** Returns cached data, or undefined when missing, stale, keyed differently, or corrupt. */
export async function readCache<T>(name: string, key: string, ttlSeconds: number): Promise<T | undefined> {
  try {
    const text = await readFile(cacheFile(name), 'utf8');
    const env = JSON.parse(text) as Envelope<T>;
    if (env.version !== CACHE_VERSION) return undefined;
    if (env.key !== key) return undefined;
    if ((Date.now() - env.savedAt) / 1000 > ttlSeconds) return undefined;
    return env.data;
  } catch {
    return undefined;
  }
}

export async function writeCache<T>(name: string, key: string, data: T): Promise<void> {
  const file = cacheFile(name);
  await mkdir(dirname(file), { recursive: true });
  const env: Envelope<T> = { version: CACHE_VERSION, savedAt: Date.now(), key, data };
  await writeFile(file, JSON.stringify(env), 'utf8');
}

export async function clearCache(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true });
}

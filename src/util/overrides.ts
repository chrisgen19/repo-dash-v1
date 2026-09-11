import type { Config, RepoOverride } from '../config.js';
import { canonicalPath } from './fs.js';

export interface OverrideIndex {
  /** The override for a working directory, matched by configured or canonical path. */
  lookup: (path: string) => Promise<RepoOverride | undefined>;
  isHidden: (path: string) => Promise<boolean>;
}

/**
 * Indexes `config.repos` under both the path as written and its canonical
 * form, so an override still applies to a repository discovered through a
 * symlinked root, and vice versa.
 */
export async function buildOverrideIndex(cfg: Config): Promise<OverrideIndex> {
  const byPath = new Map<string, RepoOverride>();
  for (const [key, override] of Object.entries(cfg.repos)) {
    if (override === undefined) continue;
    byPath.set(key, override);
    const real = await canonicalPath(key);
    if (!byPath.has(real)) byPath.set(real, override);
  }

  const lookup = async (path: string): Promise<RepoOverride | undefined> => {
    if (byPath.size === 0) return undefined;
    const direct = byPath.get(path);
    if (direct !== undefined) return direct;
    return byPath.get(await canonicalPath(path));
  };

  return { lookup, isHidden: async (path) => (await lookup(path))?.hidden === true };
}

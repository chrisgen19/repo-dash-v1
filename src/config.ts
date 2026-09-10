import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** A directory tree that gets scanned for git repositories. */
export interface RootConfig {
  /** Absolute or `~`-relative path. Environment variables are expanded. */
  path: string;
  /** How deep to descend below this root. Falls back to the global `maxDepth`. */
  maxDepth?: number;
  /** Set false to keep the entry but skip scanning it. */
  enabled?: boolean;
  /** Optional display label, shown as a group heading in the dashboard. */
  label?: string;
}

/** Per-repository overrides, keyed by absolute repo path in `config.repos`. */
export interface RepoOverride {
  /** Full command to run instead of the auto-detected one, e.g. "pnpm dev --port 4000". */
  devCommand?: string;
  /** Script name to run when auto-detecting, when it is not "dev". */
  devScript?: string;
  /** Force a package manager instead of detecting from lockfiles. */
  packageManager?: PackageManager;
  /** Hide this repo from the dashboard without removing its root. */
  hidden?: boolean;
}

export interface Config {
  roots: RootConfig[];
  /** Glob-ish patterns matched against the absolute path. `*` matches within a segment, `**` across segments. */
  ignore: string[];
  /** Directory names never descended into, at any depth. */
  pruneDirs: string[];
  maxDepth: number;
  /** Scan directories beginning with a dot. Off by default: it is mostly tool state. */
  includeHidden: boolean;
  /** Keep scanning below a repository root, so nested repos are found too. */
  scanInsideRepos: boolean;
  /** Following symlinks can wander into /mnt/c on WSL2, which is very slow. */
  followSymlinks: boolean;
  /** Parallel directory reads and git invocations. */
  concurrency: number;
  /** Command used by the "open in editor" key. */
  editor: string;
  /** Seconds before the discovery cache is considered stale. */
  cacheTtlSeconds: number;
  repos: Record<string, RepoOverride>;
}

export const CONFIG_VERSION = 1;

const DEFAULT_PRUNE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo',
  '.svelte-kit', 'vendor', '.venv', 'venv', '__pycache__', '.cache', 'coverage',
  '.pnpm-store', 'target', '.gradle', '.terraform', 'Pods',
];

export function configDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg && xdg.length > 0 ? join(xdg, 'repo-dash') : join(homedir(), '.config', 'repo-dash');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/** Expands `~`, `$VAR` and `${VAR}`, then resolves to an absolute path. */
export function expandPath(input: string): string {
  let out = input.trim();
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => process.env[name] ?? '');
  if (out === '~') out = homedir();
  else if (out.startsWith('~/')) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? resolve(out) : resolve(homedir(), out);
}

function defaults(roots: RootConfig[]): Config {
  return {
    roots,
    ignore: [],
    pruneDirs: [...DEFAULT_PRUNE_DIRS],
    maxDepth: 4,
    includeHidden: false,
    scanInsideRepos: true,
    followSymlinks: false,
    concurrency: 8,
    editor: process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'code',
    cacheTtlSeconds: 300,
    repos: {},
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Picks sensible starting roots on first run. The user edits these afterwards. */
async function seedRoots(): Promise<RootConfig[]> {
  const candidates = ['~/projects', '~/ag-projects', '~/code', '~/dev', '~/work', '~/src'];
  const found: RootConfig[] = [];
  for (const c of candidates) {
    if (await exists(expandPath(c))) found.push({ path: c });
  }
  return found.length > 0 ? found : [{ path: '~' , maxDepth: 3 }];
}

/**
 * Validates and normalizes the `roots` array. A bare string is accepted as
 * shorthand for `{ path }`. Malformed entries raise instead of reaching
 * discovery, where they would fail with an opaque property access.
 */
export function normalizeRoots(value: unknown): RootConfig[] {
  if (!Array.isArray(value)) throw new Error('"roots" must be an array');

  return value.map((entry, index) => {
    if (typeof entry === 'string') {
      if (entry.trim() === '') throw new Error(`roots[${index}] is an empty string`);
      return { path: entry };
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`roots[${index}] must be an object with a "path" string`);
    }

    const raw = entry as Record<string, unknown>;
    const path = raw['path'];
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error(`roots[${index}] is missing a "path" string`);
    }

    const out: RootConfig = { path };
    if (typeof raw['maxDepth'] === 'number') out.maxDepth = raw['maxDepth'];
    if (typeof raw['enabled'] === 'boolean') out.enabled = raw['enabled'];
    if (typeof raw['label'] === 'string') out.label = raw['label'];
    return out;
  });
}

/** Fills in any key the user left out, so a partial config file is always valid. */
function merge(raw: Partial<Config>, base: Config): Config {
  return {
    roots: raw.roots === undefined ? base.roots : normalizeRoots(raw.roots),
    ignore: Array.isArray(raw.ignore) ? raw.ignore : base.ignore,
    pruneDirs: Array.isArray(raw.pruneDirs) ? raw.pruneDirs : base.pruneDirs,
    maxDepth: typeof raw.maxDepth === 'number' ? raw.maxDepth : base.maxDepth,
    includeHidden: typeof raw.includeHidden === 'boolean' ? raw.includeHidden : base.includeHidden,
    scanInsideRepos: typeof raw.scanInsideRepos === 'boolean' ? raw.scanInsideRepos : base.scanInsideRepos,
    followSymlinks: typeof raw.followSymlinks === 'boolean' ? raw.followSymlinks : base.followSymlinks,
    concurrency: typeof raw.concurrency === 'number' ? raw.concurrency : base.concurrency,
    editor: typeof raw.editor === 'string' ? raw.editor : base.editor,
    cacheTtlSeconds: typeof raw.cacheTtlSeconds === 'number' ? raw.cacheTtlSeconds : base.cacheTtlSeconds,
    repos: raw.repos && typeof raw.repos === 'object' ? raw.repos : base.repos,
  };
}

/** Loads the config, creating a seeded one on first run. */
export async function loadConfig(): Promise<Config> {
  const file = configPath();
  if (!(await exists(file))) {
    const seeded = defaults(await seedRoots());
    await saveConfig(seeded);
    return seeded;
  }
  const text = await readFile(file, 'utf8');
  let raw: Partial<Config>;
  try {
    raw = JSON.parse(text) as Partial<Config>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Config at ${file} is not valid JSON: ${reason}`);
  }

  // An omitted `roots` key falls back to the first-run seed. An explicit
  // empty array is honoured, and means "scan nothing".
  const base = defaults(raw.roots === undefined ? await seedRoots() : []);
  try {
    return merge(raw, base);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Config at ${file}: ${reason}`);
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });

  // Write to a sibling temp file and rename, so an interrupted write cannot
  // truncate a working config and lock the user out of their roots.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Adds a root, refusing duplicates after path expansion. Returns false if already present. */
export async function addRoot(cfg: Config, path: string, maxDepth?: number): Promise<boolean> {
  const target = expandPath(path);
  if (cfg.roots.some((r) => expandPath(r.path) === target)) return false;
  const entry: RootConfig = { path };
  if (typeof maxDepth === 'number') entry.maxDepth = maxDepth;
  cfg.roots.push(entry);
  await saveConfig(cfg);
  return true;
}

/** Removes a root by path, comparing after expansion. Returns false if not found. */
export async function removeRoot(cfg: Config, path: string): Promise<boolean> {
  const target = expandPath(path);
  const before = cfg.roots.length;
  cfg.roots = cfg.roots.filter((r) => expandPath(r.path) !== target);
  if (cfg.roots.length === before) return false;
  await saveConfig(cfg);
  return true;
}

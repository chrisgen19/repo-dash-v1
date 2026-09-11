import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackageManager, RepoOverride } from '../config.js';

export interface DevCommand {
  /** Argv to run, already split. Empty when the repository has no dev script. */
  argv: string[];
  /** Why it is unavailable, when `argv` is empty. */
  reason: string | null;
  packageManager: PackageManager | null;
  script: string | null;
}

/** Lockfiles, most specific first, mapped to the manager that writes them. */
const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/** Script names tried in order when the config does not name one. */
const DEV_SCRIPTS = ['dev', 'start', 'serve'];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects the package manager from `packageManager` in the manifest, falling
 * back to whichever lockfile is present, then to npm.
 */
export async function detectPackageManager(
  repoPath: string,
  manifest: Record<string, unknown> | null,
): Promise<PackageManager> {
  const declared = manifest?.['packageManager'];
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name;
  }
  for (const [file, manager] of LOCKFILES) {
    if (await exists(join(repoPath, file))) return manager;
  }
  return 'npm';
}

async function readManifest(repoPath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Works out how to start a development server for one working directory.
 *
 * A `devCommand` override wins outright. Otherwise the manifest's scripts are
 * searched, preferring `devScript` when configured, and the detected package
 * manager runs it.
 */
export async function resolveDevCommand(
  repoPath: string,
  override: RepoOverride | undefined,
): Promise<DevCommand> {
  const empty = (reason: string): DevCommand =>
    ({ argv: [], reason, packageManager: null, script: null });

  if (override?.devCommand !== undefined && override.devCommand.trim() !== '') {
    return {
      argv: ['sh', '-c', override.devCommand],
      reason: null,
      packageManager: override.packageManager ?? null,
      script: null,
    };
  }

  const manifest = await readManifest(repoPath);
  if (manifest === null) return empty('no package.json');

  const scripts = manifest['scripts'];
  if (scripts === null || typeof scripts !== 'object') return empty('no scripts');
  const available = scripts as Record<string, unknown>;

  const wanted = override?.devScript;
  const candidates = wanted !== undefined ? [wanted] : DEV_SCRIPTS;
  const script = candidates.find((name) => typeof available[name] === 'string');
  if (script === undefined) {
    return empty(wanted !== undefined ? `no "${wanted}" script` : 'no dev script');
  }

  const packageManager = override?.packageManager ?? (await detectPackageManager(repoPath, manifest));
  // npm needs `run` and a separator; the others accept the script name directly.
  const argv = packageManager === 'npm' ? ['npm', 'run', script] : [packageManager, script];
  return { argv, reason: null, packageManager, script };
}

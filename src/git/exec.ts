import { execFile } from 'node:child_process';
import { Semaphore } from '../util/semaphore.js';
import { run, runDetached } from '../util/run.js';
import type { RunResult } from '../util/run.js';

export type GitResult = RunResult;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;

// Shared by every git call, so nested batches cannot multiply past the
// configured ceiling. One probe issues three commands, which without this
// would run 3x the limit concurrently.
const gitLimiter = new Semaphore(8);

export function setGitConcurrency(limit: number): void {
  gitLimiter.setLimit(limit);
}

export function gitConcurrency(): number {
  return gitLimiter.limit;
}

/**
 * Used when git cannot be asked for its own list. Kept in sync with
 * `git rev-parse --local-env-vars`.
 */
const FALLBACK_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
];

let localEnvVars: Promise<string[]> | undefined;

/**
 * Asks git which variables bind a process to one repository. Running this
 * without sanitizing is safe: the list is static and does not depend on the
 * surrounding repository.
 */
function readLocalEnvVars(): Promise<string[]> {
  localEnvVars ??= new Promise<string[]>((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--local-env-vars'],
      { windowsHide: true, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout) => {
        if (err !== null) return resolve(FALLBACK_LOCAL_ENV_VARS);
        const names = stdout.split('\n').map((n) => n.trim()).filter((n) => n !== '');
        resolve(names.length > 0 ? names : FALLBACK_LOCAL_ENV_VARS);
      },
    );
  });
  return localEnvVars;
}

let childEnvironment: Promise<NodeJS.ProcessEnv> | undefined;

/**
 * An inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE overrides the `cwd`
 * each call asks for, so unrelated repositories would resolve to one git
 * directory and collapse into a single result. Drop them.
 */
async function childEnv(): Promise<NodeJS.ProcessEnv> {
  childEnvironment ??= (async (): Promise<NodeJS.ProcessEnv> => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    for (const name of await readLocalEnvVars()) delete env[name];
    return env;
  })();
  return childEnvironment;
}

/**
 * Runs git in `cwd` and resolves with the result even when git fails, so one
 * broken repository cannot abort a scan over many.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps read-only commands from taking the index lock,
 * which matters when reading dozens of repositories the user may be working in.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GitResult> {
  // Resolved before taking a permit: awaiting it while holding one would let a
  // slow bootstrap occupy every permit and stall all git reads.
  const env = await childEnv();
  return gitLimiter.run(() => run('git', args, { cwd, timeoutMs, env, maxBuffer: MAX_BUFFER }));
}

/**
 * The environment for a git command that may contact a remote: the usual
 * repository isolation, plus GIT_TERMINAL_PROMPT=0 so an https remote that
 * wants credentials fails instead of waiting for input that cannot arrive.
 * Credential helpers, such as `gh auth git-credential`, still run.
 */
export async function remoteEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...(await childEnv()), GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Runs a git command that may contact a remote. It is detached from the
 * terminal, so nothing can prompt, and shares the limit on concurrent git.
 */
export async function runGitRemote(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GitResult> {
  const env = await remoteEnv();
  return gitLimiter.run(() => runDetached('git', args, { cwd, timeoutMs, env, maxBuffer: MAX_BUFFER }));
}

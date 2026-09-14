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
 *
 * Taking the terminal away is not enough on its own. With DISPLAY and
 * SSH_ASKPASS set, ssh asks an askpass program instead of the tty, and on a
 * desktop session that opens a dialog and holds the fetch until it times out;
 * git does the same through GIT_ASKPASS. Both are disabled here.
 *
 * These are environment variables rather than `GIT_SSH_COMMAND -o
 * BatchMode=yes`, which would outrank the user's own core.sshCommand and
 * quietly discard their ssh configuration.
 */
export async function remoteEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...(await childEnv()), GIT_TERMINAL_PROMPT: '0' };
  env['SSH_ASKPASS_REQUIRE'] = 'never'; // OpenSSH 8.4 and newer
  // Older ssh has no REQUIRE, and reads an askpass whenever there is no tty.
  delete env['SSH_ASKPASS'];
  delete env['GIT_ASKPASS'];
  delete env['DISPLAY'];
  return env;
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
  // core.askPass is configuration, so clearing the environment does not reach
  // it and git would still run it for an https password. An empty value reads
  // as unset, which leaves the prompt disabled rather than redirected.
  const argv = ['-c', 'core.askPass=', ...args];
  return gitLimiter.run(() => runDetached('git', argv, { cwd, timeoutMs, env, maxBuffer: MAX_BUFFER }));
}

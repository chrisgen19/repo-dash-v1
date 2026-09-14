import { execFile, spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  /** 0 on success. A non-zero exit is returned, never thrown. */
  code: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  /** Kills the command, and its group, before it finishes. */
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Runs a command and resolves with its result even when it fails, so one
 * unavailable tool cannot abort a sweep across many repositories.
 */
export function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args as string[],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const killed = err !== null && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        const raw = err === null ? 0 : (err as NodeJS.ErrnoException & { code?: number | string }).code;
        resolve({
          stdout,
          stderr,
          code: typeof raw === 'number' ? raw : err === null ? 0 : 1,
          timedOut: killed,
        });
      },
    );
  });
}

/**
 * Like `run`, but in a new session with no controlling terminal and stdin
 * closed. A program that would prompt, such as ssh asking for a passphrase,
 * then fails instead of writing over the terminal the dashboard is drawing on.
 * On timeout the whole process group is killed, because git fetch starts
 * helpers such as ssh and git-remote-https that would otherwise outlive it.
 */
export function runDetached(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const limit = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(file, args as string[], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // SIGTERM can be ignored, and then close never arrives and this promise
    // never settles, holding one of the git permits for the rest of the run.
    const terminate = (): void => {
      killGroup(child.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    };

    const onAbort = (): void => terminate();

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, timedOut });
    };

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    // Quitting the dashboard must not wait out a stalled network fetch: the
    // child and its pipes keep the process alive long after the UI is gone.
    if (options.signal !== undefined) {
      if (options.signal.aborted) terminate();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < limit) stderr += chunk.toString();
    });
    child.once('error', (err: Error) => {
      stderr += err.message;
      finish(127);
    });
    child.once('close', (code) => finish(code ?? 1));
  });
}

/** How long a timed-out process group gets to exit before it is killed. */
const KILL_GRACE_MS = 2_000;

/** Signals every process in a detached child's group. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  /** 0 on success. Non-zero exits are returned, not thrown. */
  code: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Runs git in `cwd` and resolves with the result even when git fails, so one
 * broken repository cannot abort a scan over many.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps read-only commands from taking the index lock,
 * which matters when reading dozens of repositories the user may be working in.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args as string[],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
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

import { execFile } from 'node:child_process';

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

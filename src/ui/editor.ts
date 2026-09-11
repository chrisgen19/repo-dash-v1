import { spawn } from 'node:child_process';
import { isTerminalEditor, splitCommand } from '../util/args.js';

export interface Suspend {
  /** Runs before an attached editor is handed the terminal. */
  before: () => void;
  /** Runs once it exits, whether or not it started. */
  after: () => void;
}

/**
 * Runs the configured editor on `path`.
 *
 * A terminal editor is attached to the terminal, which has to be released and
 * reclaimed around it. A windowed editor is detached so quitting the dashboard
 * does not close it. Either way a failure to launch rejects, so the caller
 * never reports a file as opened when nothing opened.
 */
export async function launchEditor(command: string, path: string, suspend?: Suspend): Promise<void> {
  const [exe, ...args] = splitCommand(command);
  if (exe === undefined) throw new Error('no editor configured');
  const argv = [...args, path];

  if (isTerminalEditor(exe, args)) {
    return runAttached(exe, argv, suspend);
  }
  return runDetached(exe, argv);
}

function runAttached(exe: string, argv: string[], suspend?: Suspend): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    suspend?.before();
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      suspend?.after();
      if (err) reject(err);
      else resolve();
    };

    const child = spawn(exe, argv, { stdio: 'inherit' });
    // A failed launch must not be reported as a successful edit.
    child.once('error', (err: Error) => finish(err));
    child.once('exit', () => finish());
  });
}

function runDetached(exe: string, argv: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(exe, argv, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

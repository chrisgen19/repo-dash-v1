import { spawn } from 'node:child_process';
import { isTerminalEditor, splitCommand } from '../util/args.js';

/**
 * Hands the terminal to `run` and restores it afterwards. Ink's
 * `useApp().suspendTerminal` has this shape and owns the full lifecycle:
 * cursor state, raw mode, and forcing a redraw once the child exits.
 */
export type Suspend = (run: () => Promise<void>) => Promise<void>;

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
    const run = (): Promise<void> => runAttached(exe, argv);
    return suspend === undefined ? run() : suspend(run);
  }
  return runDetached(exe, argv);
}

function runAttached(exe: string, argv: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return; // error and exit can both fire
      settled = true;
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

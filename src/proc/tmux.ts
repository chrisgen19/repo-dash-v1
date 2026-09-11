import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { run } from '../util/run.js';

export interface Session {
  name: string;
  /** PID of the session's first pane, the root of its process tree. */
  panePid: number;
  /** Unix seconds when the session started. */
  created: number;
}

const PREFIX = 'rd_';

/**
 * A tmux session name for one working directory.
 *
 * tmux treats `.` and `:` as address separators, so the readable part is
 * sanitized, and a hash of the full path keeps two repositories of the same
 * name apart.
 */
export function sessionName(path: string): string {
  const readable = basename(path).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24);
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 8);
  return `${PREFIX}${readable}_${digest}`;
}

export async function tmuxAvailable(): Promise<boolean> {
  return (await run('tmux', ['-V'], { timeoutMs: 3000 })).code === 0;
}

/** Sessions this tool started, keyed by name. Sessions it did not start are ignored. */
export async function listSessions(): Promise<Map<string, Session>> {
  const result = await run('tmux', [
    'list-sessions', '-F', '#{session_name}\t#{pane_pid}\t#{session_created}',
  ]);
  const sessions = new Map<string, Session>();
  // A missing server exits non-zero with "no server running", which is normal.
  if (result.code !== 0) return sessions;

  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith(PREFIX)) continue;
    const [name, pid, created] = line.split('\t');
    if (name === undefined) continue;
    sessions.set(name, {
      name,
      panePid: Number.parseInt(pid ?? '', 10) || 0,
      created: Number.parseInt(created ?? '', 10) || 0,
    });
  }
  return sessions;
}

/**
 * Starts a detached session running `argv` in `cwd`. The command is passed as
 * separate arguments rather than a string, so no shell quoting is involved.
 */
export async function startSession(name: string, cwd: string, argv: readonly string[]): Promise<string | null> {
  if (argv.length === 0) return 'no command to run';
  const result = await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '--', ...argv]);
  if (result.code === 0) return null;
  return result.stderr.trim() || `tmux exited with ${result.code}`;
}

export async function killSession(name: string): Promise<string | null> {
  const result = await run('tmux', ['kill-session', '-t', `=${name}`]);
  if (result.code === 0) return null;
  return result.stderr.trim() || `tmux exited with ${result.code}`;
}

/**
 * Recent output of a session's pane, oldest line first.
 *
 * The target needs a trailing colon: `capture-pane` addresses a pane, so
 * `=name` alone is read as a pane name and never matches.
 */
export async function capturePane(name: string, lines = 200): Promise<string> {
  const result = await run('tmux', ['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`]);
  return result.code === 0 ? result.stdout : '';
}

/**
 * Attaches the current terminal to a session and returns when the user
 * detaches. The caller must have released the terminal first; tmux needs it
 * inherited, and no timeout applies because the user decides how long to stay.
 */
export function attachSession(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['attach-session', '-t', `=${name}`], { stdio: 'inherit' });
    let settled = false;
    const finish = (message: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(message);
    };
    child.once('error', (err: Error) => finish(err.message));
    child.once('exit', (code) => finish(code === 0 || code === null ? null : `tmux exited with ${code}`));
  });
}

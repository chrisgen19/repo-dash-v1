import type { Config } from '../config.js';
import { pool } from '../util/pool.js';
import { resolveDevCommand } from './pkg.js';
import { portsByPane } from './ports.js';
import { attachSession, capturePane, killSession, listSessions, sessionName, startSession, tmuxAvailable } from './tmux.js';

export interface DevState {
  /** Working directory this describes. */
  path: string;
  sessionName: string;
  /** False when there is nothing to run; `reason` says why. */
  available: boolean;
  reason: string | null;
  running: boolean;
  /** Ports the session's process tree listens on, ascending. */
  ports: number[];
  /** Unix seconds the session started, when running. */
  since: number | null;
  /** The command that would be, or is being, run. */
  command: string[];
}

export interface DevSnapshot {
  /** False when tmux is missing; every state is then unavailable. */
  tmux: boolean;
  states: Map<string, DevState>;
}

function unavailable(path: string, reason: string, command: string[] = []): DevState {
  return {
    path, sessionName: sessionName(path), available: false, reason,
    running: false, ports: [], since: null, command,
  };
}

/**
 * Reads dev-server state for each working directory: whether one can be
 * started, whether a session is running, and which ports it holds.
 */
export async function readDevStates(paths: readonly string[], cfg: Config): Promise<DevSnapshot> {
  const states = new Map<string, DevState>();
  if (paths.length === 0) return { tmux: true, states };

  if (!(await tmuxAvailable())) {
    for (const path of paths) states.set(path, unavailable(path, 'tmux not installed'));
    return { tmux: false, states };
  }

  const sessions = await listSessions();
  const commands = await pool(paths, cfg.concurrency, (path) =>
    resolveDevCommand(path, cfg.repos[path]),
  );

  // One socket read covers every running session.
  const running = paths
    .map((path) => sessions.get(sessionName(path)))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const ports = await portsByPane(running.map((s) => s.panePid));

  paths.forEach((path, index) => {
    const dev = commands[index] as Awaited<ReturnType<typeof resolveDevCommand>>;
    const name = sessionName(path);
    const session = sessions.get(name);
    states.set(path, {
      path,
      sessionName: name,
      available: dev.argv.length > 0,
      reason: dev.reason,
      running: session !== undefined,
      ports: session === undefined ? [] : ports.get(session.panePid) ?? [],
      since: session?.created ?? null,
      command: dev.argv,
    });
  });

  return { tmux: true, states };
}

/** Starts a dev server. Returns an error message, or null on success. */
export async function startDev(path: string, cfg: Config): Promise<string | null> {
  if (!(await tmuxAvailable())) return 'tmux not installed';
  const name = sessionName(path);
  if ((await listSessions()).has(name)) return 'already running';

  const dev = await resolveDevCommand(path, cfg.repos[path]);
  if (dev.argv.length === 0) return dev.reason ?? 'nothing to run';
  return startSession(name, path, dev.argv);
}

/** Stops a dev server. Returns an error message, or null on success. */
export async function stopDev(path: string): Promise<string | null> {
  const name = sessionName(path);
  if (!(await listSessions()).has(name)) return 'not running';
  return killSession(name);
}

export async function restartDev(path: string, cfg: Config): Promise<string | null> {
  const name = sessionName(path);
  if ((await listSessions()).has(name)) {
    const error = await killSession(name);
    if (error !== null) return error;
    // tmux frees the name as the session dies; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return startDev(path, cfg);
}

/**
 * Attaches the terminal to a running session. `suspend` hands the terminal to
 * tmux and takes it back when the user detaches.
 */
export async function attachDev(
  path: string,
  suspend: (run: () => Promise<void>) => Promise<void>,
): Promise<string | null> {
  const name = sessionName(path);
  if (!(await listSessions()).has(name)) return 'not running';

  let failure: string | null = null;
  await suspend(async () => {
    const result = await attachSession(name);
    failure = result;
  });
  return failure;
}

/** Stops every session this tool started, wherever it lives. */
export async function stopAllDev(): Promise<number> {
  const sessions = await listSessions();
  let stopped = 0;
  for (const name of sessions.keys()) {
    if ((await killSession(name)) === null) stopped++;
  }
  return stopped;
}

export { capturePane };

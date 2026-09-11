import { readFile } from 'node:fs/promises';
import { run } from '../util/run.js';

export interface Listener {
  port: number;
  pid: number;
}

/**
 * Parses `ss -ltnp` output into listening sockets with their owning PID.
 *
 * A line looks like:
 *   LISTEN 0 511 *:3000 *:* users:(("node",pid=1234,fd=20))
 * Only sockets owned by this user carry a `users:` field, which is all this
 * needs: a dev server started from the dashboard is always ours.
 */
export function parseListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes('users:(')) continue;

    // The local address is the fourth column; take the port after the last colon.
    const columns = line.trim().split(/\s+/);
    const local = columns[3];
    if (local === undefined) continue;
    const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 10);
    if (!Number.isInteger(port) || port <= 0) continue;

    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number.parseInt(match[1] ?? '', 10);
      if (Number.isInteger(pid)) listeners.push({ port, pid });
    }
  }
  return listeners;
}

export async function readListeners(): Promise<Listener[]> {
  const result = await run('ss', ['-ltnpH'], { timeoutMs: 5000 });
  if (result.code !== 0) return [];
  return parseListeners(result.stdout);
}

/** Parent PID from /proc/<pid>/stat, or null when the process is gone. */
async function parentOf(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The command name may contain spaces and parentheses, so read after the
    // final ')': state is next, then ppid.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number.parseInt(fields[1] ?? '', 10);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * True when `ancestor` appears in `pid`'s parent chain. A dev server is often
 * a grandchild of the pane: tmux runs the package manager, which spawns node.
 */
export async function hasAncestor(pid: number, ancestor: number, maxDepth = 16): Promise<boolean> {
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (current === ancestor) return true;
    if (current <= 1) return false;
    const parent = await parentOf(current);
    if (parent === null) return false;
    current = parent;
  }
  return false;
}

/**
 * Ports listened on by each pane's process tree, keyed by pane PID.
 * Reads the socket table once and walks each candidate's ancestry.
 */
export async function portsByPane(panePids: readonly number[]): Promise<Map<number, number[]>> {
  const ports = new Map<number, number[]>();
  for (const pane of panePids) ports.set(pane, []);
  if (panePids.length === 0) return ports;

  const listeners = await readListeners();
  for (const listener of listeners) {
    for (const pane of panePids) {
      if (!(await hasAncestor(listener.pid, pane))) continue;
      const existing = ports.get(pane) as number[];
      if (!existing.includes(listener.port)) existing.push(listener.port);
    }
  }
  for (const list of ports.values()) list.sort((a, b) => a - b);
  return ports;
}

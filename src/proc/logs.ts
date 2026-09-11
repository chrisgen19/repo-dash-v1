import { capturePane, listSessions, sessionName } from './tmux.js';

export interface LogView {
  path: string;
  /** Lines oldest first, trailing blanks removed. */
  lines: string[];
  running: boolean;
  /** Why there is nothing to show, when `lines` is empty. */
  reason: string | null;
}

/**
 * `capture-pane -p` already strips escape sequences, but a program can still
 * emit carriage returns and other control bytes. Progress output rewrites one
 * line with `\r`, so only the final segment of each line is meaningful.
 */
export function cleanPaneOutput(raw: string, limit: number): string[] {
  const lines = raw.split('\n').map((line) => {
    const segments = line.split('\r');
    const last = segments[segments.length - 1] ?? '';
    return last.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  });

  // tmux pads the pane to its full height, so trailing blanks carry no output.
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;

  const trimmed = lines.slice(0, end);
  return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed;
}

/** Recent output of the dev server for one working directory. */
export async function readLog(path: string, limit = 200): Promise<LogView> {
  const name = sessionName(path);
  if (!(await listSessions()).has(name)) {
    return { path, lines: [], running: false, reason: 'no dev server running' };
  }

  const lines = cleanPaneOutput(await capturePane(name, Math.max(limit, 50)), limit);
  return {
    path,
    lines,
    running: true,
    reason: lines.length === 0 ? 'no output yet' : null,
  };
}

import type { GitStatus } from '../git/status.js';

export function formatAheadBehind(status: GitStatus | null): string {
  if (status === null) return '?';
  if (status.upstream === null) return '-';
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.length > 0 ? parts.join(' ') : '·';
}

export function formatBranch(status: GitStatus | null): string {
  if (status === null) return '?';
  if (status.detached) return '(detached)';
  return status.branch ?? '(no commits)';
}

export function formatDirty(status: GitStatus | null): string {
  if (status === null) return '?';
  if (status.dirty === 0) return '·';
  const marks: string[] = [String(status.dirty)];
  if (status.conflicted > 0) marks.push('!');
  return marks.join('');
}

/**
 * Renders control characters visibly instead of passing them to the terminal.
 * A repository name is a filesystem basename, so it may contain a newline,
 * which would split a row, or an ESC, which would emit a terminal sequence and
 * also throw the column widths off.
 */
export function sanitizeLabel(value: string): string {
  const named: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, (ch) => {
    const shorthand = named[ch];
    if (shorthand !== undefined) return shorthand;
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

/** Shortens to `width`, marking the cut with an ellipsis. */
export function truncate(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width === 1) return '\u2026';
  return `${value.slice(0, width - 1)}\u2026`;
}

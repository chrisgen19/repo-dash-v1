import type { RepoGroup, WorktreeView } from '../git/snapshot.js';
import type { GitStatus } from '../git/status.js';

export interface TableOptions {
  /** Show each group's linked worktrees indented beneath it. */
  expand: boolean;
}

/** "↑2 ↓5", "·" when level, or "-" without an upstream. */
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

function pad(value: string, width: number): string {
  // Arrow glyphs are single-width, so length is an adequate proxy here.
  return value + ' '.repeat(Math.max(0, width - value.length));
}

interface Row {
  cells: string[];
  indent: number;
}

function groupRow(group: RepoGroup): Row {
  const name = group.discovered ? group.name : `${group.name} (external)`;
  const suffix = group.kind === 'normal' ? '' : ` [${group.kind}]`;
  return {
    indent: 0,
    cells: [
      `${name}${suffix}`,
      formatBranch(group.status),
      formatAheadBehind(group.status),
      formatDirty(group.status),
      group.worktrees.length > 0 ? String(group.worktrees.length) : '·',
      group.lastCommit?.relative ?? '-',
    ],
  };
}

function worktreeRow(wt: WorktreeView): Row {
  const flags: string[] = [];
  if (wt.locked) flags.push('locked');
  if (wt.prunable) flags.push('prunable');
  const label = flags.length > 0 ? `${wt.name} (${flags.join(', ')})` : wt.name;
  return {
    indent: 1,
    cells: [
      `└ ${label}`,
      wt.detached ? '(detached)' : wt.branch ?? '?',
      formatAheadBehind(wt.status),
      formatDirty(wt.status),
      '',
      wt.lastCommit?.relative ?? '-',
    ],
  };
}

/** Renders the group list as an aligned plain-text table. */
export function renderTable(groups: readonly RepoGroup[], options: TableOptions): string {
  const header = ['REPO', 'BRANCH', 'AHEAD/BEHIND', 'DIRTY', 'WT', 'LAST COMMIT'];
  const rows: Row[] = [];

  for (const group of groups) {
    rows.push(groupRow(group));
    if (options.expand) {
      for (const wt of group.worktrees) rows.push(worktreeRow(wt));
    }
  }

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => ((r.cells[i] ?? '').length + (i === 0 ? r.indent * 2 : 0)))),
  );

  const lines = [header.map((h, i) => pad(h, widths[i] as number)).join('  ').trimEnd()];
  for (const row of rows) {
    const cells = row.cells.map((cell, i) => {
      const text = i === 0 ? `${'  '.repeat(row.indent)}${cell}` : cell;
      return pad(text, widths[i] as number);
    });
    lines.push(cells.join('  ').trimEnd());
  }
  return lines.join('\n');
}

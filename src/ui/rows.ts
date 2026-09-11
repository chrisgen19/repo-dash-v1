import type { RepoGroup, WorktreeView } from '../git/snapshot.js';
import { formatAheadBehind, formatBranch, formatDirty, sanitizeLabel } from './format.js';

export const COLUMNS = ['REPO', 'BRANCH', 'AHEAD/BEHIND', 'DIRTY', 'WT', 'LAST COMMIT'] as const;

export interface Row {
  kind: 'group' | 'worktree';
  /** Unique and stable across reloads, so a selection survives a refresh. */
  key: string;
  indent: number;
  cells: string[];
  group: RepoGroup;
  worktree: WorktreeView | undefined;
}

function groupRow(group: RepoGroup): Row {
  const safe = sanitizeLabel(group.name);
  const name = group.discovered ? safe : `${safe} (external)`;
  const suffix = group.kind === 'normal' ? '' : ` [${group.kind}]`;
  return {
    kind: 'group',
    key: group.path,
    indent: 0,
    cells: [
      `${name}${suffix}`,
      formatBranch(group.status),
      formatAheadBehind(group.status),
      formatDirty(group.status),
      group.worktrees.length > 0 ? String(group.worktrees.length) : '\u00b7',
      group.lastCommit?.relative ?? '-',
    ],
    group,
    worktree: undefined,
  };
}

function worktreeRow(group: RepoGroup, wt: WorktreeView): Row {
  const flags: string[] = [];
  if (wt.locked) flags.push('locked');
  if (wt.prunable) flags.push('prunable');
  const safe = sanitizeLabel(wt.name);
  const label = flags.length > 0 ? `${safe} (${flags.join(', ')})` : safe;
  return {
    kind: 'worktree',
    key: wt.path,
    indent: 1,
    cells: [
      `\u2514 ${label}`,
      wt.detached ? '(detached)' : wt.branch ?? '?',
      formatAheadBehind(wt.status),
      formatDirty(wt.status),
      '',
      wt.lastCommit?.relative ?? '-',
    ],
    group,
    worktree: wt,
  };
}

/** Flattens groups into display rows, expanding those `isExpanded` accepts. */
export function buildRows(
  groups: readonly RepoGroup[],
  isExpanded: (group: RepoGroup) => boolean,
): Row[] {
  const rows: Row[] = [];
  for (const group of groups) {
    rows.push(groupRow(group));
    if (!isExpanded(group)) continue;
    for (const wt of group.worktrees) rows.push(worktreeRow(group, wt));
  }
  return rows;
}

/** Natural column widths for a set of rows, headers included. */
export function columnWidths(rows: readonly Row[]): number[] {
  return COLUMNS.map((header, i) =>
    Math.max(
      header.length,
      ...rows.map((r) => (r.cells[i] ?? '').length + (i === 0 ? r.indent * 2 : 0)),
    ),
  );
}

/**
 * Shrinks columns to fit `budget`, taking from the widest flexible column
 * first, so one long branch name cannot push the timestamps off screen.
 */
export function fitColumns(widths: readonly number[], budget: number, gap: number): number[] {
  const out = [...widths];
  const flexible = [1, 0, 5]; // BRANCH, REPO, LAST COMMIT
  const minimum: Record<number, number> = { 0: 12, 1: 8, 5: 7 };

  const total = (): number => out.reduce((a, b) => a + b, 0) + gap * (out.length - 1);
  while (total() > budget) {
    const shrinkable = flexible
      .filter((i) => (out[i] as number) > (minimum[i] as number))
      .sort((a, b) => (out[b] as number) - (out[a] as number));
    const target = shrinkable[0];
    if (target === undefined) break;
    out[target] = (out[target] as number) - 1;
  }
  return out;
}

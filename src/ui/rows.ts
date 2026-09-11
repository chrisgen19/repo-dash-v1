import type { RepoGroup, WorktreeView } from '../git/snapshot.js';
import { formatAheadBehind, formatBranch, formatDirty, sanitizeLabel } from './format.js';

export const COLUMNS = ['REPO', 'BRANCH', 'AHEAD/BEHIND', 'DIRTY', 'WT', 'LAST COMMIT'] as const;

export interface Row {
  kind: 'group' | 'worktree' | 'heading';
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

function headingRow(group: RepoGroup, label: string): Row {
  return {
    kind: 'heading',
    key: `heading:${label}`,
    indent: 0,
    cells: [sanitizeLabel(label), '', '', '', '', ''],
    group,
    worktree: undefined,
  };
}

/** True for rows a cursor may land on; headings are labels, not entries. */
export function isSelectable(row: Row): boolean {
  return row.kind !== 'heading';
}

/** Drops headings left with no rows beneath them, as filtering can do. */
export function pruneHeadings(rows: readonly Row[]): Row[] {
  return rows.filter((row, i) => {
    if (row.kind !== 'heading') return true;
    const next = rows[i + 1];
    return next !== undefined && next.kind !== 'heading';
  });
}

/**
 * Flattens groups into display rows, expanding those `isExpanded` accepts.
 * When any root carries a label, repositories are grouped under it, which is
 * what `RootConfig.label` promises.
 */
export function buildRows(
  groups: readonly RepoGroup[],
  isExpanded: (group: RepoGroup) => boolean,
): Row[] {
  const labelled = groups.some((g) => g.rootLabel !== undefined);
  const ordered = labelled
    ? [...groups].sort(
        (a, b) =>
          (a.rootLabel ?? '\uffff').localeCompare(b.rootLabel ?? '\uffff') ||
          a.path.localeCompare(b.path),
      )
    : groups;

  const rows: Row[] = [];
  let section: string | undefined | null = null;

  for (const group of ordered) {
    if (labelled && group.rootLabel !== section) {
      section = group.rootLabel;
      rows.push(headingRow(group, section ?? 'other'));
    }
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

/** Columns dropped first when even the minimum widths will not fit. */
const DROP_ORDER = [5, 4, 2, 3, 1]; // LAST COMMIT, WT, AHEAD/BEHIND, DIRTY, BRANCH

/**
 * Shrinks columns to fit `budget`, taking from the widest flexible column
 * first, so one long branch name cannot push the timestamps off screen.
 *
 * A width of `0` means the column is hidden. Below roughly 56 cells the
 * minimum widths cannot all fit, so columns are dropped rather than allowed to
 * overflow, which would wrap every row and break the viewport arithmetic.
 * REPO is never dropped.
 */
export function fitColumns(widths: readonly number[], budget: number, gap: number): number[] {
  const out = [...widths];
  const flexible = [1, 0, 5]; // BRANCH, REPO, LAST COMMIT
  const minimum: Record<number, number> = { 0: 12, 1: 8, 5: 7 };

  const total = (): number => {
    const shown = out.filter((w) => w > 0);
    return shown.reduce((a, b) => a + b, 0) + gap * Math.max(0, shown.length - 1);
  };

  const shrink = (): boolean => {
    const target = flexible
      .filter((i) => (out[i] as number) > (minimum[i] as number))
      .sort((a, b) => (out[b] as number) - (out[a] as number))[0];
    if (target === undefined) return false;
    out[target] = (out[target] as number) - 1;
    return true;
  };

  while (total() > budget && shrink());

  for (const column of DROP_ORDER) {
    if (total() <= budget) break;
    out[column] = 0;
  }

  // Nothing left to give: clamp the one remaining column to the budget.
  if (total() > budget) out[0] = Math.max(1, budget);

  // Dropping a column can free more than was needed, so hand the slack back,
  // most important column first, rather than leaving the row short.
  for (const column of [0, 1, 5]) {
    if ((out[column] as number) === 0) continue;
    const natural = widths[column] as number;
    while ((out[column] as number) < natural && total() < budget) {
      out[column] = (out[column] as number) + 1;
    }
  }
  if (total() > budget) out[0] = (out[0] as number) - 1;
  return out;
}

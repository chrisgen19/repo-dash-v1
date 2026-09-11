import type { RepoGroup } from '../git/snapshot.js';
import { truncate } from './format.js';
import { COLUMNS, buildRows, columnWidths, fitColumns, pruneHeadings } from './rows.js';

export { formatAheadBehind, formatBranch, formatDirty, sanitizeLabel } from './format.js';

export interface TableOptions {
  /** Show each group's linked worktrees indented beneath it. */
  expand: boolean;
  /** Wrap to this width. Defaults to unlimited, which suits a pipe. */
  width?: number;
}

const GAP = 2;

function pad(value: string, width: number): string {
  // Every glyph used here is single-width, so length is an adequate proxy.
  return value + ' '.repeat(Math.max(0, width - value.length));
}

/** Renders the group list as an aligned plain-text table. */
export function renderTable(groups: readonly RepoGroup[], options: TableOptions): string {
  const rows = pruneHeadings(buildRows(groups, () => options.expand));
  const natural = columnWidths(rows);
  const widths = options.width === undefined ? natural : fitColumns(natural, options.width, GAP);

  const shown = COLUMNS.map((_, i) => i).filter((i) => (widths[i] as number) > 0);
  const cell = (text: string, i: number): string =>
    pad(truncate(text, widths[i] as number), widths[i] as number);

  const lines = [shown.map((i) => cell(COLUMNS[i] as string, i)).join(' '.repeat(GAP)).trimEnd()];
  for (const row of rows) {
    if (row.kind === 'heading') {
      // A heading spans the row rather than sitting in the first column.
      lines.push(truncate(`${row.cells[0] ?? ''}:`, Math.max(1, options.width ?? 200)));
      continue;
    }
    const cells = shown.map((i) => {
      const text = i === 0 ? `${'  '.repeat(row.indent)}${row.cells[i] ?? ''}` : row.cells[i] ?? '';
      return cell(text, i);
    });
    lines.push(cells.join(' '.repeat(GAP)).trimEnd());
  }
  return lines.join('\n');
}

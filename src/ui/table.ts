import type { RepoGroup } from '../git/snapshot.js';
import { truncate } from './format.js';
import { COLUMNS, buildRows, columnWidths, fitColumns } from './rows.js';

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
  const rows = buildRows(groups, () => options.expand);
  const natural = columnWidths(rows);
  const widths = options.width === undefined ? natural : fitColumns(natural, options.width, GAP);

  const lines = [COLUMNS.map((h, i) => pad(truncate(h, widths[i] as number), widths[i] as number)).join(' '.repeat(GAP)).trimEnd()];
  for (const row of rows) {
    const cells = row.cells.map((cell, i) => {
      const text = i === 0 ? `${'  '.repeat(row.indent)}${cell}` : cell;
      return pad(truncate(text, widths[i] as number), widths[i] as number);
    });
    lines.push(cells.join(' '.repeat(GAP)).trimEnd());
  }
  return lines.join('\n');
}

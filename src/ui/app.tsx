import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { RepoGroup } from '../git/snapshot.js';
import { sanitizeLabel, truncate } from './format.js';
import { COLUMNS, buildRows, columnWidths, fitColumns, isSelectable, pruneHeadings } from './rows.js';
import type { Row } from './rows.js';

const GAP = 2;

export interface LoadResult {
  groups: RepoGroup[];
  warnings: string[];
}

export interface AppProps {
  /** Reads repositories. `refresh` bypasses the discovery cache. */
  load: (refresh: boolean) => Promise<LoadResult>;
  /** Invoked with a repository path when the open key is pressed. */
  openInEditor: (path: string) => void | Promise<void>;
}

type Filter = 'all' | 'dirty';

function matches(row: Row, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  // A worktree row is matched on its own path, not its parent's.
  const path = row.worktree?.path ?? row.group.path;
  const haystack = [row.cells[0] ?? '', row.cells[1] ?? '', path].join(' ');
  return haystack.toLowerCase().includes(needle);
}

function isDirty(group: RepoGroup): boolean {
  if ((group.status?.dirty ?? 0) > 0) return true;
  return group.worktrees.some((w) => (w.status?.dirty ?? 0) > 0);
}

export function App({ load, openInEditor }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [groups, setGroups] = useState<RepoGroup[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(stdout.columns ?? 100);
  const [height, setHeight] = useState(stdout.rows ?? 24);
  const [status, setStatus] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const onResize = (): void => {
      setWidth(stdout.columns ?? 100);
      setHeight(stdout.rows ?? 24);
    };
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  const reload = useCallback(
    async (refresh: boolean): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await load(refresh);
        if (!mounted.current) return;
        setGroups(result.groups);
        setWarnings(result.warnings);
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [load],
  );

  useEffect(() => { void reload(false); }, [reload]);

  const visible = useMemo(
    () => (filter === 'dirty' ? groups.filter(isDirty) : groups),
    [groups, filter],
  );

  const rows = useMemo(() => {
    if (query === '') return pruneHeadings(buildRows(visible, (g) => expanded.has(g.path)));

    // Search looks inside collapsed repositories too, so a worktree-only name
    // is findable without expanding first; matches are revealed automatically.
    const all = buildRows(visible, () => true);
    const keep = new Set<string>();
    for (const row of all) {
      if (!matches(row, query)) continue;
      keep.add(row.key);
      // Keep a worktree's parent so an indented match is not orphaned.
      if (row.kind === 'worktree') keep.add(row.group.path);
    }
    return pruneHeadings(all.filter((r) => r.kind === 'heading' || keep.has(r.key)));
  }, [visible, expanded, query]);

  const index = Math.max(0, rows.findIndex((r) => r.key === selected));
  const current = rows[index];

  /** The nearest selectable row at or after `from`, searching in `step`. */
  const seek = useCallback(
    (from: number, step: number): number => {
      for (let i = from; i >= 0 && i < rows.length; i += step) {
        if (isSelectable(rows[i] as Row)) return i;
      }
      // Nothing that way: fall back to the nearest selectable in the other one.
      for (let i = from; i >= 0 && i < rows.length; i -= step) {
        if (isSelectable(rows[i] as Row)) return i;
      }
      return -1;
    },
    [rows],
  );

  // Keep a selection alive as rows appear and disappear, and off headings.
  useEffect(() => {
    if (rows.length === 0) return;
    const currentRow = rows.find((r) => r.key === selected);
    if (currentRow !== undefined && isSelectable(currentRow)) return;
    const target = seek(Math.min(index, rows.length - 1), 1);
    setSelected(target === -1 ? null : rows[target]?.key ?? null);
  }, [rows, selected, index, seek]);

  const move = useCallback(
    (delta: number): void => {
      if (rows.length === 0) return;
      const step = delta > 0 ? 1 : -1;
      let position = index;
      for (let remaining = Math.abs(delta); remaining > 0; remaining--) {
        const next = seek(position + step, step);
        if (next === -1 || next === position) break;
        position = next;
      }
      setSelected(rows[position]?.key ?? null);
    },
    [rows, index, seek],
  );

  const toggle = useCallback((): void => {
    if (current === undefined || current.kind === 'heading') return;
    const path = current.group.path;
    if (current.group.worktrees.length === 0) {
      setStatus('no linked worktrees');
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [current]);

  useInput((input, key) => {
    if (searching) {
      if (key.escape) { setSearching(false); setQuery(''); return; }
      if (key.return) { setSearching(false); return; }
      if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); return; }
      if (input.length > 0 && !key.ctrl && !key.meta) setQuery((q) => q + input);
      return;
    }

    setStatus(null);
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (key.downArrow || input === 'j') { move(1); return; }
    if (key.upArrow || input === 'k') { move(-1); return; }
    if (key.pageDown) { move(10); return; }
    if (key.pageUp) { move(-10); return; }
    if (input === 'g') { const t = seek(0, 1); if (t !== -1) setSelected(rows[t]?.key ?? null); return; }
    if (input === 'G') { const t = seek(rows.length - 1, -1); if (t !== -1) setSelected(rows[t]?.key ?? null); return; }
    if (key.return || input === ' ') { toggle(); return; }
    if (input === 'E') { setExpanded(new Set(visible.filter((g) => g.worktrees.length > 0).map((g) => g.path))); return; }
    if (input === 'C') { setExpanded(new Set()); return; }
    if (input === '/') { setSearching(true); setQuery(''); return; }
    if (input === 'D') { setFilter((f) => (f === 'dirty' ? 'all' : 'dirty')); return; }
    if (input === 'r') { void reload(false); return; }
    if (input === 'R') { void reload(true); return; }
    if (input === 'o') {
      if (current === undefined || current.kind === 'heading') return;
      const path = current.worktree?.path ?? current.group.path;
      // The path reaches the editor unchanged, but a path may contain a
      // newline or an escape, so the copy shown here is escaped like a label.
      const shown = sanitizeLabel(path);
      setStatus(`opening ${shown}`);
      void Promise.resolve(openInEditor(path))
        .then(() => { if (mounted.current) setStatus(`opened ${shown}`); })
        .catch((err: unknown) => {
          if (mounted.current) setStatus(`could not open: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  const widths = useMemo(
    () => fitColumns(columnWidths(rows), Math.max(1, width), GAP),
    [rows, width],
  );

  // Headings are labels, so the counter reports position among real entries.
  const selectable = rows.filter(isSelectable);
  const position = current === undefined
    ? 0
    : selectable.findIndex((r) => r.key === current.key) + 1;

  // Two lines of chrome above, three below.
  const viewport = Math.max(3, height - 6);
  const start = Math.min(Math.max(0, index - Math.floor(viewport / 2)), Math.max(0, rows.length - viewport));
  const windowed = rows.slice(start, start + viewport);

  if (error !== null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{error}</Text>
        <Text dimColor>press q to quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header widths={widths} />
      {loading && rows.length === 0 ? (
        <Text dimColor>  reading repositories…</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>  no repositories match</Text>
      ) : (
        windowed.map((row) => (
          <RowLine key={row.key} row={row} widths={widths} selected={row.key === selected} />
        ))
      )}
      <Footer
        width={width}
        total={selectable.length}
        position={position}
        groups={visible.length}
        loading={loading}
        filter={filter}
        query={query}
        searching={searching}
        status={status}
        warnings={warnings}
      />
    </Box>
  );
}

function totalWidth(widths: readonly number[]): number {
  const shown = widths.filter((w) => w > 0);
  return shown.reduce((a, b) => a + b, 0) + GAP * Math.max(0, shown.length - 1);
}

/** Indices of the columns wide enough to show, in display order. */
function shownColumns(widths: readonly number[]): number[] {
  return COLUMNS.map((_, i) => i).filter((i) => (widths[i] as number) > 0);
}

function Header({ widths }: { widths: number[] }): React.ReactElement {
  const shown = shownColumns(widths);
  return (
    <Box>
      {shown.map((i, n) => (
        <Text key={COLUMNS[i]} bold color="cyan">
          {pad(truncate(COLUMNS[i] as string, widths[i] as number), widths[i] as number)}
          {n < shown.length - 1 ? ' '.repeat(GAP) : ''}
        </Text>
      ))}
    </Box>
  );
}

const COLUMN_COLOR: Record<number, string | undefined> = {
  0: undefined, 1: 'green', 2: 'yellow', 3: undefined, 4: undefined, 5: undefined,
};

function RowLine({
  row, widths, selected,
}: { row: Row; widths: number[]; selected: boolean }): React.ReactElement {
  if (row.kind === 'heading') {
    return (
      <Box>
        <Text bold color="magenta">{truncate(row.cells[0] ?? '', totalWidth(widths))}</Text>
      </Box>
    );
  }

  const shown = shownColumns(widths);
  const dirtyCell = row.cells[3] ?? '\u00b7';
  const dirty = dirtyCell !== '\u00b7' && dirtyCell !== '?' && dirtyCell !== '';

  return (
    <Box>
      {shown.map((i, n) => {
        const raw = i === 0 ? `${'  '.repeat(row.indent)}${row.cells[i] ?? ''}` : row.cells[i] ?? '';
        const text = pad(truncate(raw, widths[i] as number), widths[i] as number);
        const color = selected ? undefined : i === 3 && dirty ? 'red' : COLUMN_COLOR[i];
        const dim = !selected && ((i === 0 && row.kind === 'worktree') || i === 5);
        return (
          <Text key={COLUMNS[i]} inverse={selected} color={color} dimColor={dim}>
            {text}{n < shown.length - 1 ? ' '.repeat(GAP) : ''}
          </Text>
        );
      })}
    </Box>
  );
}

const HINTS = [
  '[j/k] move', '[enter] worktrees', '[E/C] expand all/none', '[/] search',
  '[D] dirty', '[o] editor', '[r/R] reload', '[q] quit',
];

/** Drops hints from the end until the line fits, so it never wraps. */
export function fitHints(hints: readonly string[], width: number): string {
  const kept = [...hints];
  while (kept.length > 1 && kept.join('  ').length > width) kept.pop();
  const line = kept.join('  ');
  return line.length > width ? truncate(line, width) : line;
}

interface FooterProps {
  width: number;
  total: number;
  position: number;
  groups: number;
  loading: boolean;
  filter: Filter;
  query: string;
  searching: boolean;
  status: string | null;
  warnings: string[];
}

function Footer(props: FooterProps): React.ReactElement {
  const { width, total, position, groups, loading, filter, query, searching, status, warnings } = props;
  const bits = [`${position}/${total}`, `${groups} repos`];
  if (filter === 'dirty') bits.push('dirty only');
  if (loading) bits.push('reading…');

  return (
    <Box flexDirection="column" marginTop={1}>
      {warnings.map((w) => (
        <Text key={w} color="yellow">warning: {w}</Text>
      ))}
      {searching ? (
        <Text>search: <Text color="cyan">{query}</Text><Text dimColor> (enter to keep, esc to clear)</Text></Text>
      ) : status !== null ? (
        <Text color="magenta">{status}</Text>
      ) : (
        <Text dimColor>{fitHints(HINTS, width)}</Text>
      )}
      <Text dimColor>{bits.join('  ·  ')}{query !== '' && !searching ? `  ·  filter "${query}"` : ''}</Text>
    </Box>
  );
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

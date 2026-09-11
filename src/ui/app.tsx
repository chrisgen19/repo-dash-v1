import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { RepoGroup } from '../git/snapshot.js';
import { truncate } from './format.js';
import { COLUMNS, buildRows, columnWidths, fitColumns } from './rows.js';
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
  openInEditor: (path: string) => void;
}

type Filter = 'all' | 'dirty';

function matches(row: Row, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  const haystack = [row.cells[0] ?? '', row.cells[1] ?? '', row.group.path].join(' ');
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
    const all = buildRows(visible, (g) => expanded.has(g.path));
    if (query === '') return all;
    // Keep a worktree's parent row so an indented match is not orphaned.
    const keep = new Set<string>();
    for (const row of all) {
      if (!matches(row, query)) continue;
      keep.add(row.key);
      if (row.kind === 'worktree') keep.add(row.group.path);
    }
    return all.filter((r) => keep.has(r.key));
  }, [visible, expanded, query]);

  const index = Math.max(0, rows.findIndex((r) => r.key === selected));
  const current = rows[index];

  // Keep a selection alive as rows appear and disappear.
  useEffect(() => {
    if (rows.length === 0) return;
    if (selected !== null && rows.some((r) => r.key === selected)) return;
    setSelected(rows[Math.min(index, rows.length - 1)]?.key ?? null);
  }, [rows, selected, index]);

  const move = useCallback(
    (delta: number): void => {
      if (rows.length === 0) return;
      const next = Math.min(rows.length - 1, Math.max(0, index + delta));
      setSelected(rows[next]?.key ?? null);
    },
    [rows, index],
  );

  const toggle = useCallback((): void => {
    if (current === undefined) return;
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
    if (input === 'g') { setSelected(rows[0]?.key ?? null); return; }
    if (input === 'G') { setSelected(rows[rows.length - 1]?.key ?? null); return; }
    if (key.return || input === ' ') { toggle(); return; }
    if (input === 'E') { setExpanded(new Set(visible.filter((g) => g.worktrees.length > 0).map((g) => g.path))); return; }
    if (input === 'C') { setExpanded(new Set()); return; }
    if (input === '/') { setSearching(true); setQuery(''); return; }
    if (input === 'D') { setFilter((f) => (f === 'dirty' ? 'all' : 'dirty')); return; }
    if (input === 'r') { void reload(false); return; }
    if (input === 'R') { void reload(true); return; }
    if (input === 'o') {
      const path = current?.worktree?.path ?? current?.group.path;
      if (path === undefined) return;
      openInEditor(path);
      setStatus(`opened ${path}`);
    }
  });

  const widths = useMemo(
    () => fitColumns(columnWidths(rows), Math.max(40, width), GAP),
    [rows, width],
  );

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
        total={rows.length}
        position={rows.length === 0 ? 0 : index + 1}
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

function Header({ widths }: { widths: number[] }): React.ReactElement {
  return (
    <Box>
      {COLUMNS.map((label, i) => (
        <Text key={label} bold color="cyan">
          {pad(truncate(label, widths[i] as number), widths[i] as number)}
          {i < COLUMNS.length - 1 ? ' '.repeat(GAP) : ''}
        </Text>
      ))}
    </Box>
  );
}

function RowLine({
  row, widths, selected,
}: { row: Row; widths: number[]; selected: boolean }): React.ReactElement {
  const cells = row.cells.map((cell, i) => {
    const text = i === 0 ? `${'  '.repeat(row.indent)}${cell}` : cell;
    return pad(truncate(text, widths[i] as number), widths[i] as number);
  });
  const dirty = (row.cells[3] ?? '·') !== '·' && (row.cells[3] ?? '') !== '?';

  return (
    <Box>
      <Text inverse={selected} dimColor={row.kind === 'worktree' && !selected}>
        {cells[0]}{' '.repeat(GAP)}
      </Text>
      <Text inverse={selected} color={selected ? undefined : 'green'}>
        {cells[1]}{' '.repeat(GAP)}
      </Text>
      <Text inverse={selected} color={selected ? undefined : 'yellow'}>
        {cells[2]}{' '.repeat(GAP)}
      </Text>
      <Text inverse={selected} color={selected ? undefined : dirty ? 'red' : undefined}>
        {cells[3]}{' '.repeat(GAP)}
      </Text>
      <Text inverse={selected}>
        {cells[4]}{' '.repeat(GAP)}
      </Text>
      <Text inverse={selected} dimColor={!selected}>
        {cells[5]}
      </Text>
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

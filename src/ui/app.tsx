import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { RepoGroup } from '../git/snapshot.js';
import { cellWidth, padCells, sanitizeLabel, truncate } from './format.js';
import { COLUMNS, buildRows, columnWidths, fitColumns, isSelectable, pruneHeadings } from './rows.js';
import type { DevState } from '../proc/dev.js';
import type { LogView } from '../proc/logs.js';
import type { Row } from './rows.js';
import type { Suspend } from './editor.js';

const GAP = 2;

export interface LoadResult {
  groups: RepoGroup[];
  warnings: string[];
  /** Dev-server state per working directory, keyed by path. */
  dev: Map<string, DevState>;
}

/** What the dashboard can ask of a dev server. */
export type DevAction = 'start' | 'stop' | 'restart' | 'attach';

export interface AppProps {
  /** Reads repositories. `refresh` bypasses the discovery cache. */
  load: (refresh: boolean) => Promise<LoadResult>;
  /**
   * Invoked with a repository path when the open key is pressed. `suspend`
   * hands the terminal over for an editor that draws in it.
   */
  openInEditor: (path: string, suspend: Suspend) => void | Promise<void>;
  /**
   * Acts on a dev server. Resolves with an error message, or null on success.
   * `attach` hands over the terminal, so it receives the suspension too.
   */
  devAction?: (action: DevAction, path: string, suspend: Suspend) => Promise<string | null>;
  /** Reads recent dev-server output for the log pane. */
  readLog?: (path: string, limit: number) => Promise<LogView>;
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

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * A terminal that reports no size, or a size of zero, would otherwise collapse
 * every column to a single ellipsis. `??` does not catch zero, which some pty
 * setups and CI environments report.
 */
function terminalSize(stdout: { columns?: number; rows?: number }): { columns: number; rows: number } {
  const columns = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : DEFAULT_COLUMNS;
  const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : DEFAULT_ROWS;
  return { columns, rows };
}

export function App({ load, openInEditor, devAction, readLog }: AppProps): React.ReactElement {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();

  const [groups, setGroups] = useState<RepoGroup[]>([]);
  const [dev, setDev] = useState<Map<string, DevState>>(new Map());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(() => terminalSize(stdout).columns);
  const [height, setHeight] = useState(() => terminalSize(stdout).rows);
  const [status, setStatus] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<LogView | null>(null);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const onResize = (): void => {
      const size = terminalSize(stdout);
      setWidth(size.columns);
      setHeight(size.rows);
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
        setDev(result.dev);
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
    const lookup = (path: string): DevState | undefined => dev.get(path);
    if (query === '') return pruneHeadings(buildRows(visible, (g) => expanded.has(g.path), lookup));

    // Search looks inside collapsed repositories too, so a worktree-only name
    // is findable without expanding first; matches are revealed automatically.
    const all = buildRows(visible, () => true, lookup);
    const keep = new Set<string>();
    for (const row of all) {
      if (!matches(row, query)) continue;
      keep.add(row.key);
      // Keep a worktree's parent so an indented match is not orphaned.
      if (row.kind === 'worktree') keep.add(row.group.path);
    }
    return pruneHeadings(all.filter((r) => r.kind === 'heading' || keep.has(r.key)));
  }, [visible, expanded, query, dev]);

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
    if (input === 'd' || input === 's' || input === 'x' || input === 'a') {
      if (devAction === undefined || current === undefined || current.kind === 'heading') return;
      const path = current.worktree?.path ?? current.group.path;
      const action: DevAction =
        input === 'd' ? 'start' : input === 's' ? 'stop' : input === 'x' ? 'restart' : 'attach';
      setStatus(`${action}\u2026 ${sanitizeLabel(path)}`);
      void devAction(action, path, suspendTerminal)
        .then((error) => {
          if (!mounted.current) return;
          setStatus(error === null ? `${action} ok: ${sanitizeLabel(path)}` : `${action} failed: ${error}`);
          // Running state and ports change, so re-read without rescanning.
          void reload(false);
        })
        .catch((err: unknown) => {
          if (mounted.current) setStatus(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return;
    }
    if (input === 'l') { setLogOpen((open) => !open); return; }
    if (input === 'o') {
      if (current === undefined || current.kind === 'heading') return;
      const path = current.worktree?.path ?? current.group.path;
      // The path reaches the editor unchanged, but a path may contain a
      // newline or an escape, so the copy shown here is escaped like a label.
      const shown = sanitizeLabel(path);
      setStatus(`opening ${shown}`);
      void Promise.resolve(openInEditor(path, suspendTerminal))
        .then(() => { if (mounted.current) setStatus(`opened ${shown}`); })
        .catch((err: unknown) => {
          if (mounted.current) setStatus(`could not open: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  const selectedPath = current?.kind === 'heading'
    ? null
    : current?.worktree?.path ?? current?.group.path ?? null;

  // While the pane is open, poll the selected session so output stays live.
  useEffect(() => {
    if (!logOpen || readLog === undefined || selectedPath === null) {
      setLog(null);
      return undefined;
    }

    let cancelled = false;
    const refreshLog = async (): Promise<void> => {
      const view = await readLog(selectedPath, LOG_LIMIT);
      if (!cancelled && mounted.current) setLog(view);
    };

    void refreshLog();
    const timer = setInterval(() => { void refreshLog(); }, LOG_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [logOpen, readLog, selectedPath]);

  const widths = useMemo(
    () => fitColumns(columnWidths(rows), Math.max(1, width), GAP),
    [rows, width],
  );

  // Headings are labels, so the counter reports position among real entries.
  const selectable = rows.filter(isSelectable);
  const position = current === undefined
    ? 0
    : selectable.findIndex((r) => r.key === current.key) + 1;

  // The footer grows by one line per warning, so the viewport has to shrink to
  // match or the frame runs past the terminal and scrolls the window away.
  const shownWarnings = warnings.slice(0, MAX_WARNINGS);
  const hiddenWarnings = warnings.length - shownWarnings.length;
  const footerLines = 1 /* margin */ + shownWarnings.length + (hiddenWarnings > 0 ? 1 : 0) + 2;
  // The pane takes at most half of what is left, so the table stays usable.
  const available = Math.max(1, height - 1 /* header */ - footerLines);
  const logHeight = logOpen
    ? Math.max(0, Math.min(LOG_MAX_HEIGHT, Math.max(LOG_MIN_HEIGHT, Math.floor(available / 2))))
    : 0;
  const viewport = Math.max(1, available - logHeight);
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
      {logOpen ? (
        <LogPane view={log} width={width} height={logHeight} path={selectedPath} />
      ) : null}
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
        warnings={shownWarnings}
        hiddenWarnings={hiddenWarnings}
      />
    </Box>
  );
}

interface LogPaneProps {
  view: LogView | null;
  width: number;
  height: number;
  path: string | null;
}

function LogPane({ view, width, height, path }: LogPaneProps): React.ReactElement {
  // `height` covers the whole pane: its top margin, the heading, then output.
  const bodyHeight = Math.max(1, height - 2);
  const heading = truncate(
    `\u2500\u2500 logs: ${path === null ? 'nothing selected' : sanitizeLabel(basename(path))}`,
    width,
  );

  const body =
    view === null ? ['reading\u2026']
      : view.lines.length > 0 ? view.lines.slice(-bodyHeight)
        : [view.reason ?? 'no output'];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">{heading}</Text>
      {body.map((line, index) => (
        <Text key={`${index}-${line}`} dimColor={view === null || view.lines.length === 0}>
          {truncate(sanitizeLabel(line), width)}
        </Text>
      ))}
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
          {padCells(truncate(COLUMNS[i] as string, widths[i] as number), widths[i] as number)}
          {n < shown.length - 1 ? ' '.repeat(GAP) : ''}
        </Text>
      ))}
    </Box>
  );
}

const COLUMN_COLOR: Record<number, string | undefined> = {
  0: undefined, 1: 'green', 2: 'yellow', 3: undefined, 4: undefined, 5: undefined, 6: undefined,
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
        const text = padCells(truncate(raw, widths[i] as number), widths[i] as number);
        const running = i === 5 && (row.cells[5] ?? '').startsWith('\u25cf');
        const color = selected
          ? undefined
          : i === 3 && dirty ? 'red' : running ? 'green' : COLUMN_COLOR[i];
        const dim = !selected && ((i === 0 && row.kind === 'worktree') || i === 6);
        return (
          <Text key={COLUMNS[i]} inverse={selected} color={color} dimColor={dim}>
            {text}{n < shown.length - 1 ? ' '.repeat(GAP) : ''}
          </Text>
        );
      })}
    </Box>
  );
}

/** More warnings than this are summarised, to bound the footer's height. */
const MAX_WARNINGS = 3;

/** Lines requested from tmux, and how often the open pane re-reads them. */
const LOG_LIMIT = 200;
const LOG_INTERVAL_MS = 1000;
/** Rows the log pane may take, including its heading. */
const LOG_MIN_HEIGHT = 4;
const LOG_MAX_HEIGHT = 16;

const HINTS = [
  '[j/k] move', '[enter] worktrees', '[d] dev', '[s] stop', '[x] restart',
  '[l] logs', '[a] attach', '[/] search', '[D] dirty', '[o] editor',
  '[r] reload', '[q] quit',
];

/** Drops hints from the end until the line fits, so it never wraps. */
export function fitHints(hints: readonly string[], width: number): string {
  const kept = [...hints];
  while (kept.length > 1 && cellWidth(kept.join('  ')) > width) kept.pop();
  const line = kept.join('  ');
  return cellWidth(line) > width ? truncate(line, width) : line;
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
  hiddenWarnings: number;
}

function Footer(props: FooterProps): React.ReactElement {
  const {
    width, total, position, groups, loading, filter, query, searching, status, warnings, hiddenWarnings,
  } = props;
  const bits = [`${position}/${total}`, `${groups} repos`];
  if (filter === 'dirty') bits.push('dirty only');
  if (loading) bits.push('reading…');

  return (
    <Box flexDirection="column" marginTop={1}>
      {warnings.map((w) => (
        <Text key={w} color="yellow">{truncate(`warning: ${sanitizeLabel(w)}`, width)}</Text>
      ))}
      {hiddenWarnings > 0 ? (
        <Text color="yellow">{truncate(`and ${hiddenWarnings} more warnings`, width)}</Text>
      ) : null}
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


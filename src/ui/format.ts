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

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Terminal cells occupied by one code point. CJK, Hangul and emoji occupy two;
 * combining marks and zero-width joiners occupy none.
 */
function codePointCells(cp: number): number {
  if (cp === 0) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;          // combining diacritics
  if (cp >= 0x200b && cp <= 0x200f) return 0;          // zero width, joiners
  if (cp === 0xfe0f || cp === 0xfe0e) return 0;        // variation selectors
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||                  // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||                  // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) ||                  // Kana, CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) ||                  // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) ||                  // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) ||                  // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||                  // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||                  // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) ||                  // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) ||                  // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||                // emoji
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)                   // CJK extension B and beyond
  ) {
    return 2;
  }
  return 1;
}

/** Cells taken by one grapheme cluster; the widest code point in it wins. */
function graphemeCells(grapheme: string): number {
  let widest = 0;
  for (const ch of grapheme) widest = Math.max(widest, codePointCells(ch.codePointAt(0) as number));
  return widest;
}

/**
 * Terminal cells a string occupies. `String.length` counts UTF-16 code units,
 * so it under-counts CJK and emoji and would let a row overflow its column.
 */
export function cellWidth(value: string): number {
  let cells = 0;
  for (const { segment } of GRAPHEMES.segment(value)) cells += graphemeCells(segment);
  return cells;
}

/**
 * Shortens to `width` terminal cells, marking the cut with an ellipsis.
 * Cuts on grapheme boundaries, so an emoji is never split into surrogates.
 */
export function truncate(value: string, width: number): string {
  if (width <= 0) return '';
  if (cellWidth(value) <= width) return value;
  if (width === 1) return '\u2026';

  let out = '';
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(value)) {
    const cells = graphemeCells(segment);
    if (used + cells > width - 1) break;
    out += segment;
    used += cells;
  }
  return `${out}\u2026`;
}

/** Pads to `width` terminal cells, counting cells rather than code units. */
export function padCells(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - cellWidth(value)));
}

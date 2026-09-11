import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFetched, isStaleFetch } from './format.js';
import { formatAheadBehind, formatBranch, formatDirty, renderTable, sanitizeLabel } from './table.js';
import { fitColumns, buildRows, pruneHeadings, isSelectable } from './rows.js';
import { cellWidth, padCells, truncate } from './format.js';
import type { GitStatus } from '../git/status.js';
import type { RepoGroup } from '../git/snapshot.js';

function groupFixture(name: string): RepoGroup {
  return {
    name, path: `/r/${name}`, commonDir: `/r/${name}/.git`, kind: 'normal',
    rootLabel: undefined, discovered: true, status: status({}), lastCommit: null, worktrees: [],
  };
}

function status(overrides: Partial<GitStatus>): GitStatus {
  return {
    oid: 'a', branch: 'main', detached: false, upstream: 'origin/main',
    ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: 0,
    ...overrides,
  };
}

test('ahead/behind distinguishes level, diverged and no upstream', () => {
  assert.equal(formatAheadBehind(status({})), '·');
  assert.equal(formatAheadBehind(status({ ahead: 2 })), '↑2');
  assert.equal(formatAheadBehind(status({ behind: 5 })), '↓5');
  assert.equal(formatAheadBehind(status({ ahead: 2, behind: 5 })), '↑2 ↓5');
  assert.equal(formatAheadBehind(status({ upstream: null })), '-');
  assert.equal(formatAheadBehind(null), '?');
});

test('branch reflects detached and empty repositories', () => {
  assert.equal(formatBranch(status({})), 'main');
  assert.equal(formatBranch(status({ detached: true, branch: null })), '(detached)');
  assert.equal(formatBranch(status({ branch: null })), '(no commits)');
  assert.equal(formatBranch(null), '?');
});

test('dirty marks conflicts', () => {
  assert.equal(formatDirty(status({})), '·');
  assert.equal(formatDirty(status({ dirty: 3 })), '3');
  assert.equal(formatDirty(status({ dirty: 3, conflicted: 1 })), '3!');
});

test('renderTable indents worktrees only when expanded', () => {
  const group: RepoGroup = {
    name: 'app', path: '/r/app', commonDir: '/r/app/.git', kind: 'normal',
    rootLabel: undefined, discovered: true, status: status({ dirty: 2 }), lastCommit: null,
    worktrees: [{
      path: '/r/wt', name: 'wt', branch: 'feature/x', detached: false,
      locked: false, prunable: false, status: status({}), lastCommit: null,
    }],
  };

  const collapsed = renderTable([group], { expand: false });
  assert.ok(!collapsed.includes('feature/x'), 'collapsed hides worktrees');
  assert.ok(collapsed.includes('app'));

  const expanded = renderTable([group], { expand: true });
  assert.ok(expanded.includes('└ wt'));
  assert.ok(expanded.includes('feature/x'));
});

test('an external main worktree is labelled', () => {
  const group: RepoGroup = {
    name: 'app', path: '/elsewhere/app', commonDir: '/elsewhere/app/.git', kind: 'normal',
    rootLabel: undefined, discovered: false, status: null, lastCommit: null, worktrees: [],
  };
  assert.ok(renderTable([group], { expand: false }).includes('app (external)'));
});

test('sanitizeLabel renders control characters visibly', () => {
  assert.equal(sanitizeLabel('plain-name'), 'plain-name');
  assert.equal(sanitizeLabel('two\nlines'), 'two\\nlines');
  assert.equal(sanitizeLabel('a\tb'), 'a\\tb');
  assert.equal(sanitizeLabel('evil\u001b[31mRED'), 'evil\\x1b[31mRED');
  assert.equal(sanitizeLabel('bell\u0007'), 'bell\\x07');
});

test('a name containing a newline stays on one row', () => {
  // Regression: a basename may contain a newline, which split the row in two
  // and threw off every column width below it.
  const group: RepoGroup = {
    name: 'two\nlines', path: '/r/x', commonDir: '/r/x/.git', kind: 'normal',
    rootLabel: undefined, discovered: true, status: status({}), lastCommit: null,
    worktrees: [{
      path: '/r/wt', name: 'wt\u001b[31m', branch: 'b', detached: false,
      locked: false, prunable: false, status: status({}), lastCommit: null,
    }],
  };

  const rendered = renderTable([group], { expand: true });
  assert.equal(rendered.split('\n').length, 3, 'header plus two rows');
  assert.ok(!rendered.includes('\u001b'), 'no raw escape reaches the terminal');
  assert.ok(rendered.includes('two\\nlines'));
  assert.ok(rendered.includes('wt\\x1b[31m'));
});

test('columns always fit the budget, dropping some when very narrow', () => {
  // Regression: the minimum widths totalled 56, so anything narrower
  // overflowed, wrapped every row, and broke the viewport arithmetic.
  const natural = [30, 20, 12, 5, 2, 14];
  for (const budget of [10, 20, 30, 40, 50, 55, 56, 60, 80, 200]) {
    const fitted = fitColumns(natural, budget, 2);
    const shown = fitted.filter((w) => w > 0);
    const total = shown.reduce((a, b) => a + b, 0) + 2 * Math.max(0, shown.length - 1);
    assert.ok(total <= budget, `budget ${budget}: used ${total} (${JSON.stringify(fitted)})`);
    assert.ok((fitted[0] as number) > 0, `budget ${budget}: REPO must never be dropped`);
  }
});

test('a narrow table renders without wrapping', () => {
  const group: RepoGroup = {
    name: 'a-rather-long-repository-name', path: '/r/x', commonDir: '/r/x/.git', kind: 'normal',
    rootLabel: undefined, discovered: true,
    status: status({ branch: 'feature/some-very-long-branch-name' }), lastCommit: null, worktrees: [],
  };
  for (const width of [20, 40, 56, 80]) {
    const rendered = renderTable([group], { expand: false, width });
    for (const line of rendered.split('\n')) {
      assert.ok(line.length <= width, `width ${width}: line of ${line.length} -> ${line}`);
    }
  }
});

test('labelled roots become headings, unlabelled ones do not', () => {
  const personal = { ...groupFixture('alpha'), rootLabel: 'personal' };
  const work = { ...groupFixture('beta'), rootLabel: 'work' };
  const rows = buildRows([work, personal], () => false);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.cells[0]]),
    [['heading', 'personal'], ['group', 'alpha'], ['heading', 'work'], ['group', 'beta']],
    'sections are ordered by label, with the repositories under them',
  );
  assert.equal(isSelectable(rows[0] as (typeof rows)[number]), false, 'a heading is not selectable');

  const plain = buildRows([groupFixture('alpha')], () => false);
  assert.deepEqual(plain.map((r) => r.kind), ['group']);
});

test('a heading with nothing under it is dropped', () => {
  const rows = buildRows(
    [{ ...groupFixture('alpha'), rootLabel: 'personal' }, { ...groupFixture('beta'), rootLabel: 'work' }],
    () => false,
  );
  const filtered = pruneHeadings(rows.filter((r) => r.cells[0] !== 'beta'));
  assert.deepEqual(filtered.map((r) => r.cells[0]), ['personal', 'alpha']);
});

test('width is measured in terminal cells, not code units', () => {
  assert.equal(cellWidth('my-repo'), 7);
  assert.equal(cellWidth('\u65e5\u672c\u8a9e'), 6, 'CJK is double width');
  assert.equal(cellWidth('\u{1f680}'), 2, 'an emoji is double width');
  assert.equal(cellWidth('e\u0301'), 1, 'a combining accent adds nothing');
});

test('truncation respects cells and never splits a glyph', () => {
  // Regression: slicing by code unit produced a lone surrogate, and a CJK name
  // cut to N code units rendered in 2N cells.
  for (const [value, width] of [
    ['\u65e5\u672c\u8a9e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8', 8],
    ['repo-\u{1f680}-x', 7],
    ['\u{1f468}\u200d\u{1f469}\u200d\u{1f467}-family', 8],
    ['plain-name', 4],
  ] as Array<[string, number]>) {
    const out = truncate(value, width);
    assert.ok(cellWidth(out) <= width, `${JSON.stringify(out)} is ${cellWidth(out)} cells, budget ${width}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(out.replace(/\u2026$/, '')), `split surrogate in ${JSON.stringify(out)}`);
  }
});

test('padding counts cells so columns stay aligned', () => {
  assert.equal(cellWidth(padCells('\u65e5\u672c\u8a9e', 10)), 10);
  assert.equal(cellWidth(padCells('abc', 10)), 10);
});

test('a table of wide-character names still fits its width', () => {
  const wide: RepoGroup = {
    ...groupFixture('\u65e5\u672c\u8a9e\u30ea\u30dd\u30b8\u30c8\u30ea'),
    status: status({ branch: '\u{1f680}\u{1f680}\u{1f680}-branch' }),
  };
  for (const width of [24, 40, 80]) {
    for (const line of renderTable([wide], { expand: false, width }).split('\n')) {
      assert.ok(cellWidth(line) <= width, `width ${width}: ${cellWidth(line)} cells -> ${line}`);
    }
  }
});

test('an unset width leaves a long heading intact', () => {
  // Regression: headings were capped at 200 characters even with no width set,
  // losing part of a configured label in piped output.
  const label = 'L'.repeat(260);
  const group: RepoGroup = { ...groupFixture('app'), rootLabel: label };
  const heading = renderTable([group], { expand: false }).split('\n')[1] ?? '';
  assert.equal(heading, `${label}:`);
  assert.ok(!heading.includes('\u2026'));
});

test('a heading is truncated when a width is given', () => {
  const group: RepoGroup = { ...groupFixture('app'), rootLabel: 'L'.repeat(80) };
  for (const line of renderTable([group], { expand: false, width: 30 }).split('\n')) {
    assert.ok(cellWidth(line) <= 30, `${cellWidth(line)} cells -> ${line}`);
  }
});

test('fetch age reads in the largest sensible unit', () => {
  const now = 1_000_000_000_000;
  const s = now / 1000;
  assert.equal(formatFetched(s - 10, true, now), 'just now');
  assert.equal(formatFetched(s - 5 * 60, true, now), '5m ago');
  assert.equal(formatFetched(s - 3 * 3600, true, now), '3h ago');
  assert.equal(formatFetched(s - 2 * 86_400, true, now), '2d ago');
  assert.equal(formatFetched(null, true, now), 'never');
  assert.equal(formatFetched(undefined, true, now), 'never');
  assert.equal(formatFetched(s - 10, false, now), '-', 'no upstream, so no fetch changes anything');
  assert.equal(formatFetched(s + 100, true, now), 'just now', 'a future timestamp is not a negative age');
});

test('a day without fetching counts as stale', () => {
  assert.equal(isStaleFetch('never'), true);
  assert.equal(isStaleFetch('2d ago'), true);
  assert.equal(isStaleFetch('23h ago'), false);
  assert.equal(isStaleFetch('just now'), false);
  assert.equal(isStaleFetch('-'), false);
});

test('the FETCHED column is filled for repositories, not their worktrees', () => {
  const group: RepoGroup = {
    ...groupFixture('app'),
    worktrees: [{
      path: '/r/wt', name: 'wt', branch: 'b', detached: false,
      locked: false, prunable: false, status: status({}), lastCommit: null,
    }],
  };
  const [header, main, child] = renderTable([group], { expand: true }).split('\n');
  assert.match(header ?? '', /FETCHED$/);
  assert.match(main ?? '', /never$/, 'an upstream with no fetch on record');
  assert.doesNotMatch(child ?? '', /never/, "a worktree shares its repository's fetch");
});

test('a wide-character name keeps its full width when there is room', () => {
  // Regression: natural widths were measured in code units, so a CJK name was
  // given a column half its size and cut even with no width limit.
  const name = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e, 0x30ea, 0x30dd);
  const rendered = renderTable([groupFixture(name)], { expand: false });
  assert.ok(rendered.includes(name), rendered);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { App, fitHints } from './app.js';
import type { LoadResult } from './app.js';
import type { RepoGroup, WorktreeView } from '../git/snapshot.js';
import type { GitStatus } from '../git/status.js';

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    oid: 'a', branch: 'main', detached: false, upstream: 'origin/main',
    ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: 0,
    ...overrides,
  };
}

function worktree(name: string, overrides: Partial<WorktreeView> = {}): WorktreeView {
  return {
    path: `/r/${name}`, name, branch: 'wt-branch', detached: false,
    locked: false, prunable: false, status: status(), lastCommit: null,
    ...overrides,
  };
}

function group(name: string, overrides: Partial<RepoGroup> = {}): RepoGroup {
  return {
    name, path: `/r/${name}`, commonDir: `/r/${name}/.git`, kind: 'normal',
    rootLabel: undefined, discovered: true, status: status(), lastCommit: null,
    worktrees: [], ...overrides,
  };
}

// Ink 7 wraps each update in DEC synchronized-output markers, so the control
// sequences and the rendered content arrive as separate writes.
const ANSI = new RegExp(`\\u001b\\[[0-9;?]*[A-Za-z]`, 'g');

/** A stdout Ink can render into, capturing frames. Ink only draws to a TTY. */
class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 24;
  isTTY = true;
  frames: string[] = [];
  write = (frame: string): void => { this.frames.push(frame); };

  /** The most recent frame carrying actual content, not just escape codes. */
  get last(): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i] ?? '';
      if (frame.replace(ANSI, '').trim() !== '') return frame;
    }
    return '';
  }
}

/** Ink needs a raw-mode-capable TTY on stdin; a PassThrough plus these stubs is enough. */
function fakeStdin(): PassThrough {
  const stream = new PassThrough();
  return Object.assign(stream, {
    isTTY: true,
    setRawMode: (): void => undefined,
    ref: (): void => undefined,
    unref: (): void => undefined,
  });
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  /** The latest rendered content, with escape sequences removed. */
  frame: () => string;
  press: (keys: string) => Promise<void>;
  /** Polls until `predicate` holds, so tests do not race the renderer. */
  until: (predicate: () => boolean, label: string) => Promise<void>;
  cleanup: () => void;
  opened: string[];
}

async function mount(
  groups: RepoGroup[],
  onOpen?: (path: string) => Promise<unknown>,
  columns = 120,
  warnings: string[] = [],
  rows = 24,
): Promise<Harness> {
  const stdout = new FakeStdout();
  stdout.columns = columns;
  stdout.rows = rows;
  const stdin = fakeStdin();
  const opened: string[] = [];
  const load = async (): Promise<LoadResult> => ({ groups, warnings });
  const openInEditor = async (p: string): Promise<void> => {
    opened.push(p);
    if (onOpen) await onOpen(p);
  };

  const instance = render(
    createElement(App, { load, openInEditor }),
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false },
  );
  const frame = (): string => stdout.last.replace(ANSI, '');

  const until = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}\n--- last frame ---\n${frame()}`);
      }
      await tick();
    }
  };

  // The header renders before `load` resolves, so waiting for it would let a
  // keypress arrive while the list is still empty and be swallowed.
  const first = groups[0];
  await until(
    () => (first === undefined ? frame().includes('0 repos') : frame().includes(first.name)),
    'the repository list to load',
  );

  return {
    frame,
    opened,
    press: async (keys: string): Promise<void> => { stdin.write(keys); await tick(); },
    until,
    cleanup: () => instance.unmount(),
  };
}

test('renders a header and one row per repository', async () => {
  const h = await mount([group('alpha'), group('beta')]);
  await h.until(() => h.frame().includes('alpha') && h.frame().includes('beta'), 'both repositories');
  assert.match(h.frame(), /REPO\s+BRANCH/);
  assert.match(h.frame(), /2 repos/);
  h.cleanup();
});

test('j and k move the selection and clamp at the ends', async () => {
  const h = await mount([group('alpha'), group('beta'), group('gamma')]);
  await h.until(() => h.frame().includes('1/3'), 'the first row selected');
  await h.press('j');
  await h.until(() => h.frame().includes('2/3'), 'the second row');
  await h.press('j');
  await h.until(() => h.frame().includes('3/3'), 'the third row');
  await h.press('j');
  await tick(40);
  assert.match(h.frame(), /3\/3/, 'moving past the end clamps');
  await h.press('k');
  await h.until(() => h.frame().includes('2/3'), 'moving back up');
  h.cleanup();
});

test('enter expands and collapses a repository', async () => {
  const h = await mount([group('alpha', { worktrees: [worktree('alpha-wt')] })]);
  assert.doesNotMatch(h.frame(), /alpha-wt/);
  await h.press('\r');
  await h.until(() => h.frame().includes('alpha-wt'), 'the worktree to appear');
  await h.press('\r');
  await h.until(() => !h.frame().includes('alpha-wt'), 'the worktree to collapse');
  h.cleanup();
});

test('expanding a repository without worktrees explains itself', async () => {
  const h = await mount([group('alpha')]);
  await h.press('\r');
  await h.until(() => h.frame().includes('no linked worktrees'), 'the explanation');
  h.cleanup();
});

test('search filters rows and keeps a matched worktree visible', async () => {
  const h = await mount([
    group('alpha', { worktrees: [worktree('needle-wt')] }),
    group('beta'),
  ]);
  await h.press('E');            // expand all
  await h.until(() => h.frame().includes('needle-wt'), 'the worktree after expanding');
  await h.press('/');
  await h.press('needle');
  await h.until(() => h.frame().includes('needle-wt') && !h.frame().includes('beta'), 'the filtered view');
  h.cleanup();
});

test('D filters to repositories with changes, worktrees included', async () => {
  const h = await mount([
    group('clean'),
    group('messy', { status: status({ dirty: 3 }) }),
    group('clean-parent', { worktrees: [worktree('dirty-wt', { status: status({ dirty: 1 }) })] }),
  ]);
  await h.until(() => h.frame().includes('3 repos'), 'all three repositories');
  await h.press('D');
  await h.until(() => h.frame().includes('dirty only') && h.frame().includes('2 repos'), 'the dirty filter');
  assert.match(h.frame(), /messy/);
  assert.match(h.frame(), /clean-parent/);
  h.cleanup();
});

test('o opens the selected path, preferring a worktree over its parent', async () => {
  const h = await mount([group('alpha', { worktrees: [worktree('alpha-wt')] })]);
  await h.press('o');
  await h.until(() => h.opened.length === 1, 'the parent to be opened');
  assert.deepEqual(h.opened, ['/r/alpha']);
  await h.press('\r');
  await h.until(() => h.frame().includes('alpha-wt'), 'the expanded worktree');
  await h.press('j');
  await h.until(() => h.frame().includes('2/2'), 'the worktree row selected');
  await h.press('o');
  await h.until(() => h.opened.length === 2, 'the worktree to be opened');
  assert.deepEqual(h.opened, ['/r/alpha', '/r/alpha-wt']);
  h.cleanup();
});

test('a long branch name is truncated rather than wrapping', async () => {
  const long = 'feature/'.concat('x'.repeat(200));
  const h = await mount([group('alpha', { status: status({ branch: long }) })]);
  const lines = h.frame().split('\n').filter((l) => l.includes('alpha'));
  assert.equal(lines.length, 1, 'the row must not wrap');
  assert.ok((lines[0] ?? '').length <= 121, `row should fit 120 columns, got ${(lines[0] ?? '').length}`);
  h.cleanup();
});

test('the hint line is trimmed to fit rather than wrapping', () => {
  const hints = ['[a] one', '[b] two', '[c] three'];
  assert.equal(fitHints(hints, 100), '[a] one  [b] two  [c] three');
  assert.equal(fitHints(hints, 16), '[a] one  [b] two');
  assert.ok(fitHints(hints, 5).length <= 5, 'a very narrow terminal still fits');
  for (const width of [1, 4, 9, 20, 40]) {
    assert.ok(fitHints(hints, width).length <= width, `width ${width}`);
  }
});

test('search finds a worktree inside a collapsed repository', async () => {
  // Regression: rows were filtered by expansion before the query ran, so a
  // worktree-only name was invisible until the parent was expanded.
  const h = await mount([
    group('alpha', { worktrees: [worktree('needle-wt')] }),
    group('beta'),
  ]);
  assert.doesNotMatch(h.frame(), /needle-wt/, 'collapsed to begin with');
  await h.press('/');
  await h.press('needle');
  await h.until(() => h.frame().includes('needle-wt'), 'the collapsed worktree to surface');
  assert.doesNotMatch(h.frame(), /beta/);
  h.cleanup();
});

test('search matches a worktree by its own path, not its parent', async () => {
  // Regression: the haystack used group.path for worktree rows.
  const h = await mount([
    group('alpha', { worktrees: [worktree('wt', { path: '/elsewhere/zzz-unique' })] }),
    group('beta'),
  ]);
  await h.press('/');
  await h.press('zzz-unique');
  // Wait on the filter taking effect, not on a row that was already visible.
  await h.until(() => !h.frame().includes('beta'), 'the non-matching repository to drop out');
  assert.match(h.frame(), /alpha/, 'the parent of the matching worktree stays');
  h.cleanup();
});

test('the editor status reflects an async open', async () => {
  const h = await mount([group('alpha')], async (p) => {
    await new Promise((r) => setTimeout(r, 20));
    return p;
  });
  await h.press('o');
  await h.until(() => h.frame().includes('opened /r/alpha'), 'the completed open');
  h.cleanup();
});

test('rows fit a terminal narrower than the old 40-column floor', async () => {
  // Regression: the call site clamped the budget to 40, so anything narrower
  // rendered 40-wide rows that wrapped.
  for (const columns of [24, 30, 36]) {
    // A short name so the readiness check is not defeated by truncation.
    const h = await mount([group('app')], undefined, columns);
    for (const line of h.frame().split('\n')) {
      assert.ok(line.length <= columns, `at ${columns} columns: ${line.length} -> ${line}`);
    }
    h.cleanup();
  }
});

test('a failed editor launch is reported, not announced as success', async () => {
  // Regression: the spawn error was swallowed and the status still said opened.
  const h = await mount([group('alpha')], async () => {
    throw new Error('spawn nonexistent-editor ENOENT');
  });
  await h.press('o');
  await h.until(() => h.frame().includes('could not open'), 'the failure to surface');
  assert.doesNotMatch(h.frame(), /opened \/r\/alpha/);
  h.cleanup();
});

test('a path with control characters is escaped in the status line', async () => {
  // Regression: the raw path was interpolated, so a newline split the footer.
  const h = await mount([group('alpha', { path: '/r/two\nlines' })]);
  await h.press('o');
  await h.until(() => h.frame().includes('two\\nlines'), 'the escaped path');
  assert.ok(!h.frame().includes('\u001b['), 'no raw escape reaches the terminal');
  assert.deepEqual(h.opened, ['/r/two\nlines'], 'the editor still receives the real path');
  h.cleanup();
});

test('the cursor skips heading rows', async () => {
  const h = await mount([
    group('alpha', { rootLabel: 'personal' }),
    group('beta', { rootLabel: 'work' }),
  ]);
  await h.until(() => h.frame().includes('personal'), 'the headings');
  assert.match(h.frame(), /work/);

  // Four rows render, but the counter reports only the two selectable ones.
  await h.until(() => h.frame().includes('1/2'), 'the first repository selected');
  await h.press('j');
  await h.until(() => h.frame().includes('2/2'), 'the next repository, skipping the heading');
  await h.press('j');
  await tick(40);
  assert.match(h.frame(), /2\/2/, 'the last repository is the end');
  await h.press('k');
  await h.until(() => h.frame().includes('1/2'), 'back to the first repository');
  h.cleanup();
});

test('a terminal reporting no size falls back to a usable default', async () => {
  // Regression: `stdout.columns ?? 100` does not catch 0, which some pty setups
  // report, and every column collapsed to a single ellipsis.
  const h = await mount([group('alpha')], undefined, 0);
  await h.until(() => h.frame().includes('alpha'), 'a readable row');
  assert.match(h.frame(), /REPO\s+BRANCH/, 'the header is not collapsed');
  h.cleanup();
});

test('warnings shrink the viewport instead of overflowing the terminal', async () => {
  // Regression: the viewport reserved six fixed lines regardless of how many
  // warning rows the footer drew, so the frame ran past the terminal.
  const many = Array.from({ length: 8 }, (_, i) => `root not found, skipped: /missing/${i}`);
  const h = await mount(
    Array.from({ length: 30 }, (_, i) => group(`repo-${String(i).padStart(2, '0')}`)),
    undefined, 120, many, 14,
  );
  await h.until(() => h.frame().includes('repo-00'), 'the first repository');
  const lines = h.frame().split('\n').filter((l) => l !== '');
  assert.ok(lines.length <= 14, `frame is ${lines.length} lines in a 14-row terminal`);
  assert.match(h.frame(), /more warnings/, 'the extra warnings are summarised');
  h.cleanup();
});

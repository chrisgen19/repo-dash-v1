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

async function mount(groups: RepoGroup[]): Promise<Harness> {
  const stdout = new FakeStdout();
  const stdin = fakeStdin();
  const opened: string[] = [];
  const load = async (): Promise<LoadResult> => ({ groups, warnings: [] });

  const instance = render(
    createElement(App, { load, openInEditor: (p: string) => opened.push(p) }),
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

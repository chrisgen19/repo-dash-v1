import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAheadBehind, formatBranch, formatDirty, renderTable, sanitizeLabel } from './table.js';
import type { GitStatus } from '../git/status.js';
import type { RepoGroup } from '../git/snapshot.js';

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

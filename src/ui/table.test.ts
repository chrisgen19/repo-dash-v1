import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAheadBehind, formatBranch, formatDirty, renderTable } from './table.js';
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

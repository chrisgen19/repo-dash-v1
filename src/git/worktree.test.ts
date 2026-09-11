import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreeList } from './worktree.js';

const nul = (...records: string[]): string => records.map((r) => `${r}\0`).join('');

test('parses the main worktree first, then linked ones', () => {
  const worktrees = parseWorktreeList(nul(
    'worktree /home/me/app', 'HEAD aaa111', 'branch refs/heads/main', '',
    'worktree /home/me/app-feature', 'HEAD bbb222', 'branch refs/heads/feature/x', '',
  ));
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees[0]?.path, '/home/me/app');
  assert.equal(worktrees[0]?.branch, 'main', 'refs/heads/ prefix is stripped');
  assert.equal(worktrees[1]?.branch, 'feature/x');
});

test('detached, bare, locked and prunable flags', () => {
  const worktrees = parseWorktreeList(nul(
    'worktree /home/me/bare', 'HEAD ccc333', 'bare', '',
    'worktree /home/me/det', 'HEAD ddd444', 'detached', '',
    'worktree /home/me/lock', 'HEAD eee555', 'branch refs/heads/x', 'locked on purpose', '',
    'worktree /home/me/lock2', 'HEAD fff666', 'branch refs/heads/y', 'locked', '',
    'worktree /home/me/gone', 'HEAD ggg777', 'detached', 'prunable gitdir file points to non-existent location', '',
  ));
  assert.equal(worktrees[0]?.bare, true);
  assert.equal(worktrees[1]?.detached, true);
  assert.equal(worktrees[1]?.branch, null);
  assert.equal(worktrees[2]?.locked, true);
  assert.equal(worktrees[2]?.lockedReason, 'on purpose');
  assert.equal(worktrees[3]?.locked, true);
  assert.equal(worktrees[3]?.lockedReason, null, 'a bare "locked" has no reason');
  assert.equal(worktrees[4]?.prunable, true);
  assert.ok(worktrees[4]?.prunableReason?.includes('non-existent'));
});

test('a trailing record without a blank separator is still captured', () => {
  const worktrees = parseWorktreeList(nul('worktree /home/me/app', 'HEAD aaa111'));
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0]?.head, 'aaa111');
});

test('empty output yields no worktrees', () => {
  assert.deepEqual(parseWorktreeList(''), []);
});

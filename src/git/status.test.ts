import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusV2 } from './status.js';

const nul = (...records: string[]): string => records.map((r) => `${r}\0`).join('');

test('reads branch, upstream and ahead/behind headers', () => {
  const status = parseStatusV2(nul(
    '# branch.oid f61dd6e041ddd36770e472e6a9212df7396c267b',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -5',
  ));
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 5);
  assert.equal(status.detached, false);
  assert.equal(status.dirty, 0);
});

test('detached HEAD has no branch', () => {
  const status = parseStatusV2(nul('# branch.oid abc123', '# branch.head (detached)'));
  assert.equal(status.detached, true);
  assert.equal(status.branch, null);
});

test('a repository with no commits has no oid', () => {
  const status = parseStatusV2(nul('# branch.oid (initial)', '# branch.head main'));
  assert.equal(status.oid, null);
  assert.equal(status.branch, 'main');
});

test('no upstream leaves ahead and behind at zero', () => {
  const status = parseStatusV2(nul('# branch.oid abc', '# branch.head feature/x'));
  assert.equal(status.upstream, null);
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
});

test('counts staged, unstaged, untracked and conflicted separately', () => {
  const status = parseStatusV2(nul(
    '# branch.head main',
    '1 M. N... 100644 100644 100644 aaa bbb staged-only.txt',
    '1 .M N... 100644 100644 100644 aaa bbb unstaged-only.txt',
    '1 MM N... 100644 100644 100644 aaa bbb both.txt',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
    '? untracked.txt',
  ));
  assert.equal(status.staged, 2, 'staged-only and both');
  assert.equal(status.unstaged, 2, 'unstaged-only and both');
  assert.equal(status.conflicted, 1);
  assert.equal(status.untracked, 1);
  assert.equal(status.dirty, 5);
});

test('a rename does not let its original path inflate the count', () => {
  const status = parseStatusV2(nul(
    '# branch.head main',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new-name.txt',
    'old-name.txt',
    '? real-untracked.txt',
  ));
  assert.equal(status.dirty, 2, 'the rename and the untracked file');
  assert.equal(status.staged, 1);
  assert.equal(status.untracked, 1);
});

test('a path containing a newline counts once', () => {
  // The reason for -z: line splitting would count this twice.
  const status = parseStatusV2(nul('# branch.head main', '? we\nird.txt'));
  assert.equal(status.untracked, 1);
  assert.equal(status.dirty, 1);
});

test('empty output parses to a clean status', () => {
  const status = parseStatusV2('');
  assert.equal(status.dirty, 0);
  assert.equal(status.branch, null);
});

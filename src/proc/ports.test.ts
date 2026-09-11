import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAncestor, parseListeners } from './ports.js';

test('parses ss output into ports and owning pids', () => {
  const output = [
    'LISTEN 0      511          *:3000             *:*    users:(("node",pid=4242,fd=20))',
    'LISTEN 0      128    127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=99,fd=5))',
    'LISTEN 0      511       [::1]:8080            [::]:*   users:(("node",pid=77,fd=3))',
  ].join('\n');
  assert.deepEqual(parseListeners(output), [
    { port: 3000, pid: 4242 },
    { port: 5432, pid: 99 },
    { port: 8080, pid: 77 },
  ]);
});

test('a socket with no owning process is skipped', () => {
  // Sockets owned by other users carry no users:(...) field.
  assert.deepEqual(parseListeners('LISTEN 0 128 0.0.0.0:22 0.0.0.0:*'), []);
});

test('several pids on one socket are all recorded', () => {
  const line = 'LISTEN 0 511 *:3000 *:* users:(("node",pid=10,fd=20),("node",pid=11,fd=21))';
  assert.deepEqual(parseListeners(line), [
    { port: 3000, pid: 10 },
    { port: 3000, pid: 11 },
  ]);
});

test('malformed lines do not throw', () => {
  assert.deepEqual(parseListeners(''), []);
  assert.deepEqual(parseListeners('garbage users:(("x",pid=abc,fd=1))'), []);
});

test('a process is its own ancestor, and init is not a descendant', async () => {
  assert.equal(await hasAncestor(process.pid, process.pid), true);
  assert.equal(await hasAncestor(process.pid, 999_999_99), false);
});

test('a child process reports its parent as an ancestor', async () => {
  // The real reason this exists: a dev server is a grandchild of the tmux pane.
  assert.equal(await hasAncestor(process.pid, process.ppid), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchEditor } from './editor.js';

test('a missing windowed editor rejects rather than reporting success', async () => {
  await assert.rejects(launchEditor('definitely-not-a-real-editor-xyz', '/tmp'), /ENOENT/);
});

test('a missing terminal editor rejects too', async () => {
  // Regression: the attached path turned a spawn error into a resolved promise,
  // so the dashboard said "opened" when nothing had opened.
  await assert.rejects(launchEditor('kak', '/tmp'), /ENOENT/);
});

test('an empty editor setting is reported', async () => {
  await assert.rejects(launchEditor('', '/tmp'), /no editor configured/);
});

test('suspend hooks run around a terminal editor, even when it fails', async () => {
  const calls: string[] = [];
  const hooks = { before: () => calls.push('before'), after: () => calls.push('after') };
  await assert.rejects(launchEditor('kak', '/tmp', hooks));
  assert.deepEqual(calls, ['before', 'after'], 'the terminal must be handed back');
});

test('a windowed editor does not suspend the dashboard', async () => {
  const calls: string[] = [];
  const hooks = { before: () => calls.push('before'), after: () => calls.push('after') };
  await launchEditor('true', '/tmp', hooks).catch(() => undefined);
  assert.deepEqual(calls, [], 'no need to release the terminal for a detached launch');
});

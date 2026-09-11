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

/** Stands in for Ink's suspendTerminal, recording that it wrapped the run. */
function recordingSuspend(calls: string[]): (run: () => Promise<void>) => Promise<void> {
  return async (run) => {
    calls.push('suspended');
    try {
      await run();
    } finally {
      calls.push('resumed');
    }
  };
}

test('a terminal editor runs inside the suspension, even when it fails', async () => {
  const calls: string[] = [];
  await assert.rejects(launchEditor('kak', '/tmp', recordingSuspend(calls)));
  assert.deepEqual(calls, ['suspended', 'resumed'], 'the terminal must be handed back');
});

test('a windowed editor does not suspend the dashboard', async () => {
  const calls: string[] = [];
  await launchEditor('true', '/tmp', recordingSuspend(calls)).catch(() => undefined);
  assert.deepEqual(calls, [], 'a detached launch never takes the terminal');
});

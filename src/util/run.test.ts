import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetached } from './run.js';

test('a detached command leads its own session, away from the terminal', async (t) => {
  // A new session has no controlling terminal, so ssh cannot open /dev/tty to
  // ask for a passphrase in the middle of the dashboard.
  const result = await runDetached('sh', ['-c', 'echo "$$ $(ps -o sid= -p $$)"']);
  if (result.code !== 0) return t.skip('ps unavailable');
  const [pid, sid] = result.stdout.trim().split(/\s+/);
  assert.equal(sid, pid, 'the command is its own session leader');
});

test('stdin is closed, so nothing can wait for input', async () => {
  const result = await runDetached('sh', ['-c', 'read line; echo "got:$line"'], { timeoutMs: 3000 });
  assert.equal(result.timedOut, false, 'read hit end of input instead of hanging');
  assert.equal(result.stdout.trim(), 'got:');
});

test('a timeout kills the whole process group', async () => {
  // The background sleep holds stdout open, so the result only arrives once
  // it is dead too: a timeout that killed just the shell would take 30 seconds.
  const started = Date.now();
  const result = await runDetached('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000, `returned after ${Date.now() - started}ms`);

  const child = Number.parseInt(result.stdout.trim(), 10);
  const deadline = Date.now() + 2000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(child, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the background sleep was killed with its shell');
});

test('a missing command is reported, not thrown', async () => {
  const result = await runDetached('definitely-not-a-command-xyz', []);
  assert.notEqual(result.code, 0);
});

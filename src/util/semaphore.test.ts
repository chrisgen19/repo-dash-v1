import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from './semaphore.js';

/** Runs `count` tasks through the semaphore, recording peak overlap. */
async function peak(limit: number, count: number): Promise<number> {
  const sem = new Semaphore(limit);
  let active = 0;
  let max = 0;
  await Promise.all(
    Array.from({ length: count }, () =>
      sem.run(async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  return max;
}

test('never exceeds its limit', async () => {
  assert.equal(await peak(1, 10), 1);
  assert.equal(await peak(3, 20), 3);
  assert.equal(await peak(8, 30), 8);
});

test('a limit above the task count is not a floor', async () => {
  assert.equal(await peak(10, 2), 2);
});

test('invalid limits fall back to one', () => {
  assert.equal(new Semaphore(0).limit, 1);
  assert.equal(new Semaphore(-5).limit, 1);
  assert.equal(new Semaphore(Number.NaN).limit, 1);
  assert.equal(new Semaphore(2.9).limit, 2);
});

test('raising the limit releases waiters', async () => {
  const sem = new Semaphore(1);
  let active = 0;
  let max = 0;
  const task = async (): Promise<void> => {
    await sem.run(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
  };
  const all = Promise.all([task(), task(), task(), task()]);
  setTimeout(() => sem.setLimit(4), 5);
  await all;
  assert.ok(max > 1, `expected concurrency to rise after setLimit, saw ${max}`);
});

test('a throwing task still releases its permit', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await sem.run(async () => 'ok'), 'ok');
});

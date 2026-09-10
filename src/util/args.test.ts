import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRootsAdd } from './args.js';

test('option value is not mistaken for the path', () => {
  // Regression: `--depth 2 ~/src` used to add a root literally named "2".
  const r = parseRootsAdd(['--depth', '2', '~/src']);
  assert.deepEqual(r, { ok: true, value: { path: '~/src', maxDepth: 2 } });
});

test('path before option works too', () => {
  const r = parseRootsAdd(['~/src', '--depth', '3']);
  assert.deepEqual(r, { ok: true, value: { path: '~/src', maxDepth: 3 } });
});

test('--depth= form is accepted', () => {
  const r = parseRootsAdd(['--depth=5', '~/src']);
  assert.deepEqual(r, { ok: true, value: { path: '~/src', maxDepth: 5 } });
});

test('path alone omits maxDepth', () => {
  assert.deepEqual(parseRootsAdd(['~/src']), { ok: true, value: { path: '~/src' } });
});

test('malformed input is rejected with a reason', () => {
  assert.equal(parseRootsAdd([]).ok, false);
  assert.equal(parseRootsAdd(['--depth']).ok, false);
  assert.equal(parseRootsAdd(['--depth', 'abc', '~/s']).ok, false);
  assert.equal(parseRootsAdd(['--depth', '-1', '~/s']).ok, false);
  assert.equal(parseRootsAdd(['~/a', '~/b']).ok, false);
  assert.equal(parseRootsAdd(['--nope', '~/a']).ok, false);
});

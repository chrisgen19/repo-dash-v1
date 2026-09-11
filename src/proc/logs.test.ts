import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPaneOutput } from './logs.js';

const BELL = String.fromCharCode(7);
const CR = String.fromCharCode(13);

test('carriage returns collapse to the final segment', () => {
  // Progress output rewrites one line, so only the last state is meaningful.
  const raw = ['first', `10%${CR}50%${CR}100%`, 'last'].join('\n');
  assert.deepEqual(cleanPaneOutput(raw, 10), ['first', '100%', 'last']);
});

test('control bytes are stripped but text is kept', () => {
  assert.deepEqual(cleanPaneOutput(`with${BELL}bell`, 10), ['withbell']);
});

test('trailing blank lines from pane padding are dropped', () => {
  // tmux pads the pane to its full height; those rows are not output.
  assert.deepEqual(cleanPaneOutput('a\nb\n\n\n   \n', 10), ['a', 'b']);
});

test('blank lines inside the output are kept', () => {
  assert.deepEqual(cleanPaneOutput('a\n\nb\n', 10), ['a', '', 'b']);
});

test('the limit keeps the most recent lines', () => {
  const raw = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(cleanPaneOutput(raw, 3), ['line 17', 'line 18', 'line 19']);
});

test('empty output yields no lines', () => {
  assert.deepEqual(cleanPaneOutput('', 10), []);
  assert.deepEqual(cleanPaneOutput('\n\n\n', 10), []);
});

test('a tab is preserved, since it is not a control byte to strip', () => {
  assert.deepEqual(cleanPaneOutput('a\tb', 10), ['a\tb']);
});

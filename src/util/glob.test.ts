import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGlob } from './glob.js';

test('** followed by / spans whole segments only', () => {
  // Regression: `**/node_modules` used to match `my_node_modules`.
  assert.equal(matchesGlob('/work/my_node_modules/x', '**/node_modules'), false);
  assert.equal(matchesGlob('/work/xnode_modulesy/a', '**/node_modules'), false);
  assert.equal(matchesGlob('/work/node_modules/x', '**/node_modules'), true);
  assert.equal(matchesGlob('/a/b/c/node_modules', '**/node_modules'), true);
  assert.equal(matchesGlob('/node_modules', '**/node_modules'), true);
});

test('single star stays inside one segment', () => {
  assert.equal(matchesGlob('/a/cgd-portfolio-v4', '**/cgd-portfolio-*'), true);
  assert.equal(matchesGlob('/a/portfolio-v4', '**/cgd-portfolio-*'), false);
  assert.equal(matchesGlob('/a/b/c', 'a/*/c'), true);
  assert.equal(matchesGlob('/a/b/x/c', 'a/*/c'), false);
});

test('bare words match any single segment', () => {
  assert.equal(matchesGlob('/home/me/docs/learn', 'docs'), true);
  assert.equal(matchesGlob('/home/me/mydocs/learn', 'docs'), false);
});

test('question mark matches one character', () => {
  assert.equal(matchesGlob('/a/v1', 'v?'), true);
  assert.equal(matchesGlob('/a/v10', 'v?'), false);
});

test('empty pattern never matches', () => {
  assert.equal(matchesGlob('/anything', ''), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalEditor, parseRootsAdd, splitCommand } from './args.js';

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

test('partially numeric depth values are rejected', () => {
  // Regression: parseInt turned "2.5", "2junk" and "1e3" into 2, 2 and 1.
  for (const bad of ['2.5', '2junk', '1e3', '0x10', '-1', '', ' ']) {
    assert.equal(parseRootsAdd([`--depth=${bad}`, '~/x']).ok, false, `should reject ${bad}`);
  }
  assert.deepEqual(parseRootsAdd(['--depth= 3 ', '~/x']), {
    ok: true, value: { path: '~/x', maxDepth: 3 },
  });
});

test('splitCommand separates an executable from its arguments', () => {
  // Regression: `EDITOR="code --wait"` was spawned as one executable name.
  assert.deepEqual(splitCommand('code --wait'), ['code', '--wait']);
  assert.deepEqual(splitCommand('vim'), ['vim']);
  assert.deepEqual(splitCommand('  nvim   -f  '), ['nvim', '-f']);
  assert.deepEqual(splitCommand('"/opt/my editor/bin" -f'), ['/opt/my editor/bin', '-f']);
  assert.deepEqual(splitCommand("'my editor' --wait"), ['my editor', '--wait']);
  assert.deepEqual(splitCommand(''), []);
});

test('terminal editors are told apart from windowed ones', () => {
  // Regression: a terminal editor spawned detached with no stdio gets no
  // terminal and hangs in the background.
  for (const cmd of ['vim', 'nvim', 'vi', 'nano', 'helix', 'hx', 'emacs', '/usr/bin/vim']) {
    const [exe, ...args] = splitCommand(cmd);
    assert.equal(isTerminalEditor(exe as string, args), true, cmd);
  }
  for (const cmd of ['code', 'code --wait', 'subl -w', 'gvim', 'notepad.exe']) {
    const [exe, ...args] = splitCommand(cmd);
    assert.equal(isTerminalEditor(exe as string, args), false, cmd);
  }
  // gvim only draws in the terminal when asked to.
  assert.equal(isTerminalEditor('gvim', ['-v']), true);
  assert.equal(isTerminalEditor('gvim', ['-nw']), true);
});

test('a Windows editor path is recognised', () => {
  // Regression: splitting on "/" alone left "C:\\...\\vim" unmatched, so a
  // terminal editor was launched detached and hung with no terminal.
  for (const cmd of ['"C:\\\\Program Files\\\\Vim\\\\vim.exe"', 'C:\\\\tools\\\\nvim.exe']) {
    const [exe, ...args] = splitCommand(cmd);
    assert.equal(isTerminalEditor(exe as string, args), true, cmd);
  }
  const [code] = splitCommand('"C:\\\\Program Files\\\\Microsoft VS Code\\\\code.exe"');
  assert.equal(isTerminalEditor(code as string, []), false);
});

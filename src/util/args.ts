export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RootsAddArgs {
  path: string;
  maxDepth?: number;
}

/**
 * Parses `roots add` arguments so option values are never mistaken for the
 * positional path. Accepts `--depth 2` and `--depth=2`, in any order relative
 * to the path.
 */
export function parseRootsAdd(args: readonly string[]): ParseResult<RootsAddArgs> {
  let path: string | undefined;
  let maxDepth: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;

    if (arg === '--depth' || arg.startsWith('--depth=')) {
      const raw = arg.startsWith('--depth=') ? arg.slice('--depth='.length) : args[++i];
      if (raw === undefined || raw === '') return { ok: false, error: '--depth requires a number' };
      // parseInt would accept "2.5", "2junk" and "1e3" as 2, 2 and 1, silently
      // storing a depth the user never asked for.
      if (!/^\d+$/.test(raw.trim())) {
        return { ok: false, error: `--depth expects a non-negative integer, got "${raw}"` };
      }
      maxDepth = Number.parseInt(raw.trim(), 10);
      continue;
    }

    if (arg.startsWith('-')) return { ok: false, error: `unknown option: ${arg}` };
    if (path !== undefined) return { ok: false, error: `unexpected extra argument: ${arg}` };
    path = arg;
  }

  if (path === undefined) return { ok: false, error: 'a path is required' };
  return { ok: true, value: maxDepth === undefined ? { path } : { path, maxDepth } };
}

/**
 * Splits a configured command into an executable and its arguments, honouring
 * quoted segments. `spawn` takes the executable alone, so a value such as
 * `code --wait` or `"/opt/my editor/bin" -f` must be split first.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Editors that draw in the terminal and therefore need it handed over, rather
 * than GUI editors that detach and return immediately. Matched on the
 * executable's base name, so an absolute path still resolves.
 */
const TERMINAL_EDITORS = new Set([
  'vi', 'vim', 'nvim', 'vimx', 'nano', 'pico', 'emacs', 'emacsclient',
  'micro', 'helix', 'hx', 'kak', 'ne', 'joe', 'mcedit', 'ed', 'nvi', 'jed',
]);

const WINDOWED_FLAGS = ['-nw', '--no-window-system', '-v'];

/**
 * True when the command draws in the terminal and must be handed the tty.
 *
 * The two mistakes are not symmetric. Treating a terminal editor as windowed
 * leaves it running with no terminal, which is the failure this guards
 * against; treating a windowed editor as a terminal one only pauses the
 * dashboard until it exits. `emacs` therefore counts as a terminal editor
 * unless nothing suggests otherwise, while `gvim` opens a window by default.
 */
export function isTerminalEditor(command: string, args: readonly string[] = []): boolean {
  // Both separators: a configured Windows path would otherwise never match.
  const base = (command.split(/[/\\]/).pop() ?? command).replace(/\.(exe|cmd|bat)$/i, '');
  if (base === 'gvim') return args.some((a) => WINDOWED_FLAGS.includes(a));
  return TERMINAL_EDITORS.has(base);
}

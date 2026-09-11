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

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
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, error: `--depth expects a non-negative integer, got "${raw}"` };
      }
      maxDepth = parsed;
      continue;
    }

    if (arg.startsWith('-')) return { ok: false, error: `unknown option: ${arg}` };
    if (path !== undefined) return { ok: false, error: `unexpected extra argument: ${arg}` };
    path = arg;
  }

  if (path === undefined) return { ok: false, error: 'a path is required' };
  return { ok: true, value: maxDepth === undefined ? { path } : { path, maxDepth } };
}
